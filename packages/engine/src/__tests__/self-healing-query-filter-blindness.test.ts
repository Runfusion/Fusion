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
import { getTaskHardMergeBlocker, resolveLifecycleColumns } from "@fusion/core";

/*
FNXC:WorkflowResolvedColumns 2026-07-30-21:40:
`classifyForeignOnlyContamination` is a STATIC named import in the sweep, so `vi.spyOn` on the module
object cannot intercept it under ESM — the binding is already resolved. Only the other named exports are
passed through, so the sweeps in this file that use `inspectBranchConflict` are unaffected.
*/
/*
FNXC:WorkflowResolvedColumns 2026-07-30-21:40:
The sweep logs through `createLogger("self-healing")`, which writes to console.error. Spying on
console.error does NOT work here — vitest installs its own console interceptor above the spy, so the
line appears in the run output while the spy records nothing (it did, and read as "no warn emitted").
Mocking the logger module captures the call itself, one level below the console.
*/
/*
FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (batch fold):
`isBranchAheadOfBase` is a STATIC named import that shells out to git, so it is mocked rather than spied —
the ESM binding is resolved before a spy could replace it.
*/
/*
FNXC:WorkflowResolvedColumns 2026-08-10-10:32:
A `vi.mock` specifier for a moved module does not fail at declaration time: its lazy factory never
runs, local `vi.fn()` seams remain unwired, and assertions misleadingly report that a sweep never ran.
Keep these paths aligned with self-healing's imports so this renamed-lane ratchet observes its seams.
*/
const isBranchAheadOfBase = vi.fn(async () => ({ aheadCount: 0 }));
vi.mock("../healing/self-healing-branch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../healing/self-healing-branch.js")>();
  return { ...actual, isBranchAheadOfBase: (...args: unknown[]) => isBranchAheadOfBase(...args as []) };
});

const selfHealingWarn = vi.fn();
vi.mock("../logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logger.js")>();
  return {
    ...actual,
    createLogger: (prefix: string) => {
      const real = actual.createLogger(prefix);
      return prefix === "self-healing" ? { ...real, warn: (...args: unknown[]) => { selfHealingWarn(...args); real.warn(...args as [string]); } } : real;
    },
  };
});

const classifyForeignOnlyContamination = vi.fn(async () => ({ kind: "clean" as const }));
vi.mock("../execution/branch-conflicts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../execution/branch-conflicts.js")>();
  return { ...actual, classifyForeignOnlyContamination: (...args: unknown[]) => classifyForeignOnlyContamination(...args as []) };
});

vi.mock("../util/run-audit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../util/run-audit.js")>();
  return {
    ...actual,
    createRunAuditor: vi.fn(() => ({ database: vi.fn(async () => undefined), git: vi.fn(), filesystem: vi.fn(), sandbox: vi.fn() })),
  };
});

import { createRunAuditor } from "../util/run-audit.js";
import { SelfHealingManager } from "../self-healing.js";
import { executingTaskLock } from "../agents/active-session-registry.js";
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
    transitionQueuedEpisode: vi.fn(async () => ({ appended: true })),
    /*
    FNXC:WorkflowResolvedColumns 2026-08-10-10:32:
    `surfaceInReviewStalls` reads the merge queue before reporting a stalled renamed-lane card.
    Mirror its Promise<MergeQueueEntry[]> seam so a missing fake method cannot abort the sweep and
    leave a superficially green assertion vacuous.
    */
    peekMergeQueue: vi.fn(async () => []),
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
    logEntry: vi.fn(async () => undefined),
    getAgentLogs: vi.fn(async () => []),
    parseFileScopeFromPrompt: vi.fn(async () => []),
    recordRunAuditEvent: vi.fn(async () => undefined),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
  }) as unknown as TaskStore & EventEmitter;
  return {
    store,
    listTasks,
    updateTask: store.updateTask as unknown as ReturnType<typeof vi.fn>,
    transitionQueuedEpisode: store.transitionQueuedEpisode as unknown as ReturnType<typeof vi.fn>,
    peekMergeQueue: store.peekMergeQueue as unknown as ReturnType<typeof vi.fn>,
  };
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
  FNXC:WorkflowResolvedColumns 2026-07-30-20:05 (the query-filter class — the last read-shaped sweep):

  `surfaceInReviewStalls` kicks a card that has sat in review past `taskStuckTimeoutMs` back to the
  hold lane. Its query asked for the literal `in-review`, so on a renamed board it received NOTHING and
  the review column silently stopped draining — an operator sees cards accumulating with no error and
  no log line, because a sweep that finds zero candidates is indistinguishable from a healthy one.

  Asserted on the QUERY, like its siblings here, for the reason the file header gives: the outcome is 0
  either way, so only the query argument distinguishes "nothing to do" from "asked the wrong question".

  `checking` AND `in-review` are both expected — `resolveProjectColumnsForRoles` unions the legacy id
  deliberately, so a board mid-rename with rows still under the old id is not skipped.

  REVERT PROOF, measured: restore `listTasks({ column: "in-review", slim: false })` and the first
  assertion fails; the second keeps passing, which is exactly why asserting only the legacy id would
  have been no test at all.
  */
  it("surfaceInReviewStalls asks for the board's own review lane, not the literal", async () => {
    const stalled = {
      ...shippedCard(),
      id: "FN-STALL",
      column: RENAMED_VOCAB.review,
      updatedAt: new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(),
    } as Task;
    const { store, listTasks } = productionFaithfulStore([stalled]);
    (store as unknown as { getSettings: ReturnType<typeof vi.fn> }).getSettings = vi.fn(async () => ({
      globalPause: false,
      enginePaused: false,
      taskStuckTimeoutMs: 60_000,
    }) as Settings);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    await manager.surfaceInReviewStalls();

    expect(listTasks).toHaveBeenCalledWith(expect.objectContaining({ column: RENAMED_VOCAB.review }));
    expect(listTasks).toHaveBeenCalledWith(expect.objectContaining({ column: "in-review" }));
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
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-22:00 (the query-filter class, seventh sweep):
  `finalizeNoOpReviewTasks` finalises a task whose branch has NO commits ahead of base — a genuine no-op
  merge. Its literal read meant such a task sat in review forever on a renamed board.

  One of the four sweeps holding both a literal query and an unwired `getTaskMergeBlocker`, so the guard
  is wired in the same change: widening the read alone would have found the card and declined it.

  REVERT CHECK, measured (each independently):
    - literal read restored     -> the card is never found
    - { reviewColumns } dropped -> the card is found and then declined by the blocker
  */
  it("finalizes a no-op card on a RENAMED board, past the now-reachable blocker", async () => {
    const noOp = {
      ...shippedCard(),
      id: "FN-NOOP",
      column: RENAMED_VOCAB.review,
      status: null,
      worktree: "/tmp/wt",
      steps: [],
      mergeDetails: {},
    } as unknown as Task;
    const { store, listTasks } = productionFaithfulStore([noOp]);
    Object.assign(store, { logEntry: vi.fn(async () => undefined) });

    const manager = new SelfHealingManager(store, { rootDir: "/repo" });
    /*
    ASSERTS CANDIDACY. My first version asserted `getSettings` was called — which the sweep does
    unconditionally on its first line, so it proved nothing. `isBranchAheadOfBase` runs ONCE PER
    CANDIDATE, after the filter, so it is the first observable that separates "found and accepted"
    from "found and declined by the blocker".
    */
    const aheadCheck = vi
      .spyOn(manager as unknown as { isBranchAheadOfBase: (t: Task, b: string) => Promise<boolean> },
             "isBranchAheadOfBase")
      .mockResolvedValue(false);

    await manager.finalizeNoOpReviewTasks();

    expect(listTasks).toHaveBeenCalledWith(expect.objectContaining({ column: RENAMED_VOCAB.review }));
    expect(aheadCheck).toHaveBeenCalled();
  });
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-22:40 (the query-filter class, eighth sweep):
  `recoverCompletionHandoffLimbo` clears a task falsely marked completion-handoff-exhausted while the
  merge queue already owns it. Its literal read meant such a task stayed wedged on a renamed board.

  ASSERTS CANDIDACY, per the rule this file's siblings had to learn four times: `isMergeLaneOwned` runs
  once per row that has already passed BOTH the lane test and the merge blocker, so it is the first
  observable separating "found and accepted" from "found and skipped". `getSettings` would not do — the
  sweep calls it on its first line.

  REVERT CHECK, measured (each independently):
    - literal read restored     -> never reached, the card is not found
    - { reviewColumns } dropped -> the card is found and then skipped by the blocker
  */
  it("reaches a limbo card on a RENAMED board, past the now-reachable blocker", async () => {
    const wedged = {
      ...shippedCard(),
      id: "FN-LIMBO",
      column: RENAMED_VOCAB.review,
      status: null,
      worktree: "/tmp/wt",
      steps: [],
      /* The limbo gate requires status/mergeDetails/review/reviewState ALL null — `{}` is not null. */
      mergeDetails: undefined,
      log: [{ action: "Task marked done by agent", timestamp: new Date(Date.now() - 86_400_000).toISOString() }],
    } as unknown as Task;
    const { store } = productionFaithfulStore([wedged]);
    Object.assign(store, { logEntry: vi.fn(async () => undefined) });

    const manager = new SelfHealingManager(store, { rootDir: "/repo" });
    vi.spyOn(manager as unknown as { isMergeLaneOwned: (id: string) => Promise<boolean> }, "isMergeLaneOwned")
      .mockResolvedValue(false);
    /*
    DOWNSTREAM of the blocker, deliberately. `isMergeLaneOwned` runs BEFORE it, so spying there would
    prove the read and say nothing about the wiring — an observable upstream of the thing under test is
    the same vacuity in a new costume. `recoverApprovedStrandedAiMergeCommit` is the first call after the
    blocker check.
    */
    const pastBlocker = vi
      .spyOn(manager as unknown as {
        recoverApprovedStrandedAiMergeCommit: (t: Task, s: unknown) => Promise<boolean>;
      }, "recoverApprovedStrandedAiMergeCommit")
      .mockResolvedValue(true);

    await manager.recoverCompletionHandoffLimbo();

    expect(pastBlocker).toHaveBeenCalled();
  });
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, fifteenth sweep):
  `recoverMergedReviewTasks` finalizes a task whose merge is CONFIRMED but which never reached the
  complete lane. Two literal reads meant that on a renamed board the card sat in review or hold forever
  while its commit was already on the base branch — merged work that the board still shows as unfinished.

  Observable is `resolveSelfHealingMergeTarget`, a private method called once per candidate, so the
  assertion sits downstream of both the read and the per-card verdict without needing a git fixture.

  REVERT CHECKS, both measured, each alone:
    - literal reads restored -> fails, the card is never listed
    - verdict back to `t.column === "in-review"` -> fails, the renamed review lane does not match
  */
  it("finalizes a merge-confirmed card stranded on a RENAMED review lane", async () => {
    const merged = {
      ...shippedCard(),
      id: "FN-MERGED",
      column: RENAMED_VOCAB.review,
      mergeDetails: { mergeConfirmed: true, commitSha: "abcdef1234567890" },
    } as unknown as Task;
    const { store } = productionFaithfulStore([merged]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });
    const resolveTarget = vi.fn(async () => ({ branch: "main", source: "settings" }));
    Object.assign(manager, {
      resolveSelfHealingMergeTarget: resolveTarget,
      isCommitReachableFromBranch: vi.fn(async () => false),
      recordSharedGroupDefaultTargetGuard: vi.fn(async () => undefined),
    });

    await manager.recoverMergedReviewTasks();

    expect(resolveTarget).toHaveBeenCalledWith(
      expect.objectContaining({ id: "FN-MERGED" }),
      expect.anything(),
      "recover-merged-review",
    );
  });
  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-18:20:
  The HOLD half of the same sweep, and it was uncovered on the #3115 map. The case above pins
  `mergedReviewColumns`; blinding `mergedHoldColumns` back to `["todo"]` left the whole file green,
  because no case put a merge-confirmed card in a renamed hold lane.

  That lane is not hypothetical: a merge-confirmed card gets REBOUNDED to hold by other recovery paths
  (a failed post-merge step, a requeue), so "merged but sitting in hold" is exactly the state this
  sweep's second bucket exists to finalize. Keyed on the id, that bucket read nothing on a renamed
  board and the card stayed unfinished with its commit already on the base branch.
  */
  it("finalizes a merge-confirmed card stranded on a RENAMED hold lane", async () => {
    const merged = {
      ...shippedCard(),
      id: "FN-MERGED-HOLD",
      column: RENAMED_VOCAB.hold,
      mergeDetails: { mergeConfirmed: true, commitSha: "abcdef1234567890" },
    } as unknown as Task;
    const { store } = productionFaithfulStore([merged]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });
    const resolveTarget = vi.fn(async () => ({ branch: "main", source: "settings" }));
    Object.assign(manager, {
      resolveSelfHealingMergeTarget: resolveTarget,
      isCommitReachableFromBranch: vi.fn(async () => false),
      recordSharedGroupDefaultTargetGuard: vi.fn(async () => undefined),
    });

    await manager.recoverMergedReviewTasks();

    expect(resolveTarget).toHaveBeenCalledWith(
      expect.objectContaining({ id: "FN-MERGED-HOLD" }),
      expect.anything(),
      "recover-merged-review",
    );
  });
  it("ignores a merge-confirmed card sitting in the RENAMED wip lane", async () => {
    /*
    Non-vacuous companion: without it, a read returning every column would satisfy the case above. This
    sweep covers review and hold only — a card mid-execution is not its business.
    */
    const merged = {
      ...shippedCard(),
      id: "FN-MERGED",
      column: RENAMED_VOCAB.wip,
      mergeDetails: { mergeConfirmed: true, commitSha: "abcdef1234567890" },
    } as unknown as Task;
    const { store } = productionFaithfulStore([merged]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });
    const resolveTarget = vi.fn(async () => ({ branch: "main", source: "settings" }));
    Object.assign(manager, {
      resolveSelfHealingMergeTarget: resolveTarget,
      isCommitReachableFromBranch: vi.fn(async () => false),
      recordSharedGroupDefaultTargetGuard: vi.fn(async () => undefined),
    });

    await manager.recoverMergedReviewTasks();

    expect(resolveTarget).not.toHaveBeenCalled();
  });
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, twenty-first sweep):
  `recoverStaleMergingStatus` clears a `merging`/`merging-pr` stamp left on a review card with no live
  merger behind it. The literal read meant that on a renamed board the stamp was never cleared, so the
  card read as mid-merge forever — and that stamp is what the merger AND the dashboard's manual Retry
  gate both consult, so the card could neither progress on its own nor be retried by hand.

  `updatedAt` is deliberately ancient: `isStaleMergeActiveStatus` requires the stamp to have sat
  untouched for `minAgeMs`, so a fresh fixture would be filtered out for a reason unrelated to lanes.

  REVERT CHECKS, both measured, each alone:
    - literal read restored -> fails, the card is never listed
    - verdict back to `task.column !== "in-review"` -> fails, the renamed review lane is filtered out
  */
  it("clears a stale merge stamp on a RENAMED review lane", async () => {
    const stuck = {
      ...shippedCard(),
      id: "FN-STALESTAMP",
      column: RENAMED_VOCAB.review,
      status: "merging",
      updatedAt: "2020-01-01T00:00:00.000Z",
    } as unknown as Task;
    const { store, updateTask } = productionFaithfulStore([stuck]);

    await new SelfHealingManager(store, {
      rootDir: "/repo",
      getActiveMergeTaskId: () => null,
    }).recoverStaleMergingStatus();

    expect(updateTask).toHaveBeenCalledWith("FN-STALESTAMP", expect.objectContaining({ status: null }));
  });
  it("does not clear a merge stamp on a card outside the RENAMED review lanes", async () => {
    /*
    Non-vacuous companion: without it, a read returning every column would satisfy the case above. A
    merge stamp on a wip card is not this sweep's business — recoverInProgressLimbo and the executor own
    that lane.
    */
    const stuck = {
      ...shippedCard(),
      id: "FN-STALESTAMP",
      column: RENAMED_VOCAB.wip,
      status: "merging",
      updatedAt: "2020-01-01T00:00:00.000Z",
    } as unknown as Task;
    const { store, updateTask } = productionFaithfulStore([stuck]);

    await new SelfHealingManager(store, { rootDir: "/repo" }).recoverStaleMergingStatus();

    expect(updateTask).not.toHaveBeenCalled();
  });
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, fourteenth sweep):
  `recoverForeignOnlyContaminatedInReviewTasks` classifies a branch that carries ONLY foreign commits and
  clears the contamination park nothing else clears. Two literal reads meant that on a renamed board it
  classified nothing and the task stayed parked indefinitely.

  The two `task.column === …` checks inside its filters were redundant while the query pinned the column;
  under a resolved read they ARE the per-card verdict, so they convert here rather than being deleted.

  `classifyForeignOnlyContamination` is a module function needing git, so the observable is CANDIDACY —
  it is called once per accepted card and not at all for a card the filters reject, which is exactly the
  read-plus-verdict this change is about.

  REVERT CHECK, measured: with the literal reads restored, this fails — the card is never listed, so the
  classifier is never called for it.
  */
  it("classifies a foreign-only contaminated branch on a RENAMED review lane", async () => {
    const parked = {
      ...shippedCard(),
      id: "FN-FOREIGN",
      column: RENAMED_VOCAB.review,
      branch: "fusion/FN-FOREIGN",
      worktree: "/tmp/worktrees/FN-FOREIGN",
      mergeDetails: {},
    } as unknown as Task;
    const { store } = productionFaithfulStore([parked]);
    classifyForeignOnlyContamination.mockClear();

    await new SelfHealingManager(store, { rootDir: "/repo" }).recoverForeignOnlyContaminatedInReviewTasks();

    expect(classifyForeignOnlyContamination).toHaveBeenCalledWith(expect.objectContaining({ taskId: "FN-FOREIGN" }));
  });
  it("does not classify a card whose lane is neither review nor wip on a RENAMED board", async () => {
    /*
    Non-vacuous companion: without it, a read returning every column would satisfy the case above. Same
    board, same card — only its lane changes, to the board's own hold lane.
    */
    const parked = {
      ...shippedCard(),
      id: "FN-FOREIGN",
      column: RENAMED_VOCAB.hold,
      branch: "fusion/FN-FOREIGN",
      worktree: "/tmp/worktrees/FN-FOREIGN",
      mergeDetails: {},
    } as unknown as Task;
    const { store } = productionFaithfulStore([parked]);
    classifyForeignOnlyContamination.mockClear();

    await new SelfHealingManager(store, { rootDir: "/repo" }).recoverForeignOnlyContaminatedInReviewTasks();

    expect(classifyForeignOnlyContamination).not.toHaveBeenCalled();
  });
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (#2891 review P1 — the card the sweep disowned):
  `resolveWorkflowIrForTask` does not fail; it SUBSTITUTES the built-in IR. So a card whose workflow
  selection is missing or unreadable came back measured against `in-review`/`in-progress`, and the
  per-card verdicts then REJECTED the very card the project-scoped query had just admitted from a renamed
  lane. The sweep found it and immediately disowned it.

  The fix falls back to the PROJECT sets that admitted the card, so it is CLASSIFIED rather than dropped.
  This asserts that outcome rather than a log line — the observable is stronger and does not depend on
  wording.

  SUPERSEDED 2026-07-30 (#2891 review, second round): this asserted that the card IS classified, which
  was true of the project-union fallback I shipped first and is no longer the behaviour. Review pushed
  back that widening on an ACTION site — these verdicts clear a contamination pause — lets a column
  carrying a recovery role only in ANOTHER workflow admit this card. The union was replaced by
  skip-and-report: without the card's own board we do not decide, and the card is logged so it is
  visible rather than silently mis-decided in either direction.

  So the assertion is inverted rather than deleted. What it now pins is the same property from the
  other side — a renamed-lane card with no resolvable workflow must NOT be acted on — and it still
  fails if someone restores either earlier answer, because both of those classify it.
  */
  it("does NOT classify a renamed-lane card whose own workflow cannot be resolved", async () => {
    const parked = {
      ...shippedCard(),
      id: "FN-NOWORKFLOW",
      column: RENAMED_VOCAB.review,
      branch: "fusion/FN-NOWORKFLOW",
      worktree: "/tmp/worktrees/FN-NOWORKFLOW",
      mergeDetails: {},
    } as unknown as Task;
    const { store } = productionFaithfulStore([parked]);
    /* The PROJECT's definitions still resolve (so the card is listed); the CARD's own selection does not. */
    Object.assign(store, {
      getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
      getTaskWorkflowSelection: vi.fn(() => undefined),
    });
    classifyForeignOnlyContamination.mockClear();

    await new SelfHealingManager(store, { rootDir: "/repo" }).recoverForeignOnlyContaminatedInReviewTasks();

    expect(classifyForeignOnlyContamination).not.toHaveBeenCalled();
  });
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-23:58 (the query-filter class, tenth sweep):
  `recoverPostDoneNonContinuableWedge` clears a `failed` status on a task that finished every step and
  was then wedged only because a post-done session continuation hit a non-continuable error. Its literal
  read meant a renamed board's card stayed failed forever with all work done.

  THE ONE SWEEP WHERE BOTH HALVES ARE PROVABLE. Its outcome — updateTask clearing `status`/`error` — is
  downstream of the read AND of the getTaskHardMergeBlocker wired in the same change, and nothing on the
  path needs git. Contrast the orphan-only sweep, where the blocker sits behind two git calls and only
  candidacy could be asserted.

  REVERT CHECKS, both measured, each run alone:
    - literal read restored              -> fails, the card is never listed
    - `{ reviewColumns: wedgeLanes }` dropped -> fails, the blocker judges the renamed lane as
      not-a-review-lane and the sweep declines the card it just found
  */
  it("clears a post-done wedge on a RENAMED board, and the blocker judges the card's own lanes", async () => {
    const wedged = {
      ...shippedCard(),
      id: "FN-WEDGE",
      column: RENAMED_VOCAB.review,
      status: "failed",
      steps: [{ id: "s1", status: "done" }],
      log: [
        { action: "Task marked done by agent", outcome: "" },
        { action: "", outcome: "cannot continue from message role: assistant" },
      ],
    } as unknown as Task;
    const { store, updateTask } = productionFaithfulStore([wedged]);

    await new SelfHealingManager(store, { rootDir: "/repo" }).recoverPostDoneNonContinuableWedge();

    expect(updateTask).toHaveBeenCalledWith("FN-WEDGE", expect.objectContaining({ status: null, error: null }));
  });
  it("does not clear a wedge for a card sitting in a lane that is NOT a review lane", async () => {
    /*
    Non-vacuous companion: without it, a read that returned every column would satisfy the case above.
    Same renamed board, same wedged card — only its lane changes.
    */
    const wedged = {
      ...shippedCard(),
      id: "FN-WEDGE-WIP",
      column: RENAMED_VOCAB.wip,
      status: "failed",
      steps: [{ id: "s1", status: "done" }],
      log: [
        { action: "Task marked done by agent", outcome: "" },
        { action: "", outcome: "cannot continue from message role: assistant" },
      ],
    } as unknown as Task;
    const { store, updateTask } = productionFaithfulStore([wedged]);

    await new SelfHealingManager(store, { rootDir: "/repo" }).recoverPostDoneNonContinuableWedge();

    expect(updateTask).not.toHaveBeenCalled();
  });
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, eleventh sweep):
  `clearStaleBlockedBy` is the sweep that unsticks a card still pointing at a blocker that has since
  finished. Its BODY was already lane-resolved — per-referenced-task lanes, a shared IR cache, legacy ids
  unioned, all of it — and none of that ran, because the three reads above it asked for the literal
  `todo`/`in-progress`/`in-review`. A textbook case of the class this file exists for: the expensive half
  was converted and delivered nothing while the cheap half above it stayed literal.

  Three reads, not one union: the buckets are treated DIFFERENTLY downstream (hold cards seed the
  queued-dependency pass; review cards are exempted when paused), so each card is classified against its
  own workflow after the union read.

  REVERT CHECK, measured: with the three literal reads restored, this fails — the blocked card is never
  listed, so its stale `blockedBy` is never cleared.
  */
  it("clears a stale blockedBy on a RENAMED board once the blocker has landed", async () => {
    const blocker = { ...shippedCard(), id: "FN-BLOCKER", column: RENAMED_VOCAB.complete } as Task;
    const blocked = {
      ...shippedCard(),
      id: "FN-STUCK",
      column: RENAMED_VOCAB.wip,
      blockedBy: "FN-BLOCKER",
      dependencies: [],
    } as unknown as Task;
    const { store, updateTask } = productionFaithfulStore([blocker, blocked]);

    await new SelfHealingManager(store, { rootDir: "/repo" }).clearStaleBlockedBy();

    expect(updateTask).toHaveBeenCalledWith("FN-STUCK", expect.objectContaining({ blockedBy: null }));
  });
  it("leaves blockedBy alone while the blocker is still in flight on a RENAMED board", async () => {
    /*
    Non-vacuous companion: without it, a sweep that cleared every blockedBy it found would satisfy the
    case above. Same board, same pair — only the blocker's lane changes.
    */
    const blocker = { ...shippedCard(), id: "FN-BLOCKER", column: RENAMED_VOCAB.wip } as Task;
    const blocked = {
      ...shippedCard(),
      id: "FN-STUCK",
      column: RENAMED_VOCAB.wip,
      blockedBy: "FN-BLOCKER",
      dependencies: [],
    } as unknown as Task;
    const { store, updateTask } = productionFaithfulStore([blocker, blocked]);

    await new SelfHealingManager(store, { rootDir: "/repo" }).clearStaleBlockedBy();

    expect(updateTask).not.toHaveBeenCalled();
  });
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, twelfth sweep):
  `reclaimSelfOwnedBranchConflicts` frees a task whose OWN worktree is holding its OWN branch hostage —
  a conflict no other sweep resolves. Three literal reads plus three lane guards in the body, so both
  halves convert together: widening the read alone would admit renamed-board cards and then mis-decide
  every one, since the phantom-binding check, the blocked-hold skip and the review triple-proof are each
  keyed on lane.

  ONE ASSERTION COVERS BOTH HALVES. `isPhantomExecutorBinding` runs only for a card that (a) the read
  found and (b) the wip-lane guard accepted. Two private seams are stubbed to reach it —
  `getFalsePositiveRequeueSignal` for the live-execution signal, and the binding check itself — which is
  the same technique used above for the orphan sweep, and avoids a git/fs fixture entirely.

  REVERT CHECKS, both measured, each run alone:
    - literal reads restored          -> fails, the card is never listed
    - guard back to `task.column === "in-progress"` -> fails, the renamed wip lane does not match, so the
      sweep falls through to the no-action path
  */
  it("reclaims a self-owned branch conflict on a RENAMED wip lane, guard included", async () => {
    const stuck = {
      ...shippedCard(),
      id: "FN-SELFCONFLICT",
      column: RENAMED_VOCAB.wip,
      branch: "fusion/FN-SELFCONFLICT",
      worktree: "/tmp/worktrees/FN-SELFCONFLICT",
      executionStartedAt: "2026-07-30T00:00:00.000Z",
    } as unknown as Task;
    const { store } = productionFaithfulStore([stuck]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });
    /* Returns the real shape, not null: the sweep reads `.phantom` straight off it, so a null stub throws and aborts the loop after ONE card — which silently capped the multi-role count at 1 in both states. */
    const isPhantomExecutorBinding = vi.fn(() => ({ phantom: false, metadata: {} }));
    Object.assign(manager, {
      getFalsePositiveRequeueSignal: vi.fn(() => ({ reason: "executor-active", metadata: {} })),
      getRecentRunAuditActivityAgeMs: vi.fn(async () => 0),
      isPhantomExecutorBinding,
      emitFalsePositiveRequeueNoAction: vi.fn(async () => undefined),
    });

    await manager.reclaimSelfOwnedBranchConflicts();

    expect(isPhantomExecutorBinding).toHaveBeenCalledWith(
      expect.objectContaining({ id: "FN-SELFCONFLICT" }),
      expect.anything(),
    );
  });
  it("does not evaluate a phantom binding for a card sitting in the RENAMED review lane", async () => {
    /*
    Non-vacuous companion: without it, a guard matching every column would satisfy the case above. Same
    board, same card, same stubs — only its lane changes, and the review lane must not take the wip path.
    */
    const stuck = {
      ...shippedCard(),
      id: "FN-SELFCONFLICT",
      column: RENAMED_VOCAB.review,
      paused: true,
      pausedReason: "branch-conflict-unrecoverable",
      branch: "fusion/FN-SELFCONFLICT",
      worktree: "/tmp/worktrees/FN-SELFCONFLICT",
      executionStartedAt: "2026-07-30T00:00:00.000Z",
    } as unknown as Task;
    const { store } = productionFaithfulStore([stuck]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });
    /* Returns the real shape, not null: the sweep reads `.phantom` straight off it, so a null stub throws and aborts the loop after ONE card — which silently capped the multi-role count at 1 in both states. */
    const isPhantomExecutorBinding = vi.fn(() => ({ phantom: false, metadata: {} }));
    Object.assign(manager, {
      getFalsePositiveRequeueSignal: vi.fn(() => ({ reason: "executor-active", metadata: {} })),
      getRecentRunAuditActivityAgeMs: vi.fn(async () => 0),
      isPhantomExecutorBinding,
      emitFalsePositiveRequeueNoAction: vi.fn(async () => undefined),
    });

    await manager.reclaimSelfOwnedBranchConflicts();

    expect(isPhantomExecutorBinding).not.toHaveBeenCalled();
  });
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (review P1 on #2879 — the hazard the conversion CREATED):
  The three literal reads were disjoint BY CONSTRUCTION: one column each, so a card could not appear
  twice. Resolved reads are not. A custom workflow may put more than one queried role flag on the SAME
  column — here `hold` beside `wip`, a lane that both parks work and counts as work — and that column is
  returned by two reads.

  Concatenating the buckets then hands the loop the same STALE SNAPSHOT twice. Not a wasted iteration:
  the second pass reads `branch`/`worktree` from state captured before the first pass mutated anything,
  so a worktree already reclaimed is reclaimed again against state that no longer exists.

  REVERT CHECK, measured: with the dedupe removed, this fails with 2 calls instead of 1.
  */
  it("processes a multi-role column ONCE, not once per role", async () => {
    const multiRoleIr = {
      ...RENAMED_IR,
      columns: RENAMED_IR.columns.map((column) =>
        column.id === RENAMED_VOCAB.hold
          ? { ...column, traits: [...column.traits, { trait: "wip", config: { limitSetting: "maxConcurrent", countPending: true } }] }
          : column,
      ),
    } as typeof RENAMED_IR;
    const stuck = {
      ...shippedCard(),
      id: "FN-MULTIROLE",
      column: RENAMED_VOCAB.hold,
      branch: "fusion/FN-MULTIROLE",
      worktree: "/tmp/worktrees/FN-MULTIROLE",
      executionStartedAt: "2026-07-30T00:00:00.000Z",
    } as unknown as Task;
    const { store } = productionFaithfulStore([stuck]);
    Object.assign(store, {
      listWorkflowDefinitions: vi.fn(async () => [{ ir: multiRoleIr }]),
      getWorkflowDefinition: vi.fn(async (id: string) => (id === "self-healing-lifecycle" ? { ir: multiRoleIr } : undefined)),
    });
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });
    /* Returns the real shape, not null: the sweep reads `.phantom` straight off it, so a null stub throws and aborts the loop after ONE card — which silently capped the multi-role count at 1 in both states. */
    const isPhantomExecutorBinding = vi.fn(() => ({ phantom: false, metadata: {} }));
    Object.assign(manager, {
      getFalsePositiveRequeueSignal: vi.fn(() => ({ reason: "executor-active", metadata: {} })),
      getRecentRunAuditActivityAgeMs: vi.fn(async () => 0),
      isPhantomExecutorBinding,
      emitFalsePositiveRequeueNoAction: vi.fn(async () => undefined),
    });

    await manager.reclaimSelfOwnedBranchConflicts();

    expect(isPhantomExecutorBinding).toHaveBeenCalledTimes(1);
  });
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, thirteenth sweep):
  `reconcileCompletedTask` releases everything blocked on a task that just completed. Three literal reads
  meant that on a renamed board it released NOTHING — every dependent stayed blocked on work that had
  already finished. This is the most visible form of the class: the board simply stops moving, with no
  error and no log line saying why.

  The dependency-satisfaction guard converts in the same change, resolved PER DEPENDENCY: a dependency
  routinely belongs to a different workflow than the card waiting on it.

  REVERT CHECK, measured: with the three literal reads restored, this fails — the dependent is never
  listed, so its `blockedBy` is never cleared.
  */
  it("releases a dependent on a RENAMED board when its blocker completes", async () => {
    const finished = { ...shippedCard(), id: "FN-DONE", column: RENAMED_VOCAB.complete } as Task;
    const waiting = {
      ...shippedCard(),
      id: "FN-WAITING",
      column: RENAMED_VOCAB.wip,
      blockedBy: "FN-DONE",
      dependencies: [],
    } as unknown as Task;
    const { store, updateTask } = productionFaithfulStore([finished, waiting]);

    await new SelfHealingManager(store, { rootDir: "/repo" }).reconcileCompletedTask("FN-DONE");

    expect(updateTask).toHaveBeenCalledWith("FN-WAITING", expect.objectContaining({ blockedBy: null }));
  });
  it("does not release a dependent blocked on a DIFFERENT task", async () => {
    /*
    Non-vacuous companion: without it, a sweep that cleared every blockedBy it found would satisfy the
    case above. Same board, same shape — only the blocker id differs.
    */
    const finished = { ...shippedCard(), id: "FN-DONE", column: RENAMED_VOCAB.complete } as Task;
    const waiting = {
      ...shippedCard(),
      id: "FN-WAITING",
      column: RENAMED_VOCAB.wip,
      blockedBy: "FN-SOMEONE-ELSE",
      dependencies: [],
    } as unknown as Task;
    const { store, updateTask } = productionFaithfulStore([finished, waiting]);

    await new SelfHealingManager(store, { rootDir: "/repo" }).reconcileCompletedTask("FN-DONE");

    expect(updateTask).not.toHaveBeenCalledWith("FN-WAITING", expect.objectContaining({ blockedBy: null }));
  });
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the P1 raised on #2879, same hazard in this sweep):
  Resolved reads can return ONE column for TWO roles, so a dependent lands in two buckets and the release
  below runs twice — `updateTask` and `logEntry` both fire twice for one card, and `blockedByCleared`
  over-counts. The literal reads could not do this: one column each, disjoint by construction.

  REVERT CHECK, measured: without the dedupe this fails with 2 clearing writes instead of 1.
  */
  it("releases a dependent ONCE when its column carries two queried roles", async () => {
    const multiRoleIr = {
      ...RENAMED_IR,
      columns: RENAMED_IR.columns.map((column) =>
        column.id === RENAMED_VOCAB.hold
          ? { ...column, traits: [...column.traits, { trait: "wip", config: { limitSetting: "maxConcurrent", countPending: true } }] }
          : column,
      ),
    } as typeof RENAMED_IR;
    const finished = { ...shippedCard(), id: "FN-DONE", column: RENAMED_VOCAB.complete } as Task;
    const waiting = {
      ...shippedCard(),
      id: "FN-WAITING",
      column: RENAMED_VOCAB.hold,
      blockedBy: "FN-DONE",
      dependencies: [],
    } as unknown as Task;
    const { store, updateTask } = productionFaithfulStore([finished, waiting]);
    Object.assign(store, {
      listWorkflowDefinitions: vi.fn(async () => [{ ir: multiRoleIr }]),
      getWorkflowDefinition: vi.fn(async (id: string) => (id === "self-healing-lifecycle" ? { ir: multiRoleIr } : undefined)),
    });

    await new SelfHealingManager(store, { rootDir: "/repo" }).reconcileCompletedTask("FN-DONE");

    const clearingWrites = (updateTask as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .filter(([id, patch]) => id === "FN-WAITING" && (patch as { blockedBy?: unknown }).blockedBy === null);
    expect(clearingWrites).toHaveLength(1);
  });
  /*
  FNXC:WorkflowResolvedColumns 2026-08-10-10:32:
  A dependency is satisfied when it reaches a TERMINAL lane or a REVIEW lane, and review here means
  `mergeBlocker ∪ humanReview` — NOT merge orchestration. My first version unioned all three review
  roles, which counts a merge-orchestration-only column as satisfied and clears `blockedBy` while the
  dependency is still being merged.

  The fix is to call `resolveDependencySatisfactionColumns`, the answer the scheduler already uses for
  this exact question, rather than to re-derive it. FNXC:QueuedTaskLogging 2026-08-04-18:32 moved this
  hold branch from `updateTask` to `transitionQueuedEpisode`, so the ratchet pins the current durable
  transition seam rather than a retired write path.

  REVERT CHECK, measured: widening the satisfaction set to include `mergeOrchestration` fails this — the
  dependent is released while its dependency is still mid-merge.
  */
  it("does NOT treat a merge-orchestration-only dependency as satisfied", async () => {
    /* A board whose merge lane is SEPARATE from its human-review lane. */
    const splitReviewIr = {
      ...RENAMED_IR,
      columns: [
        ...RENAMED_IR.columns.map((column) =>
          column.id === RENAMED_VOCAB.review
            ? { ...column, traits: column.traits.filter((t: { trait: string }) => t.trait !== "merge") }
            : column,
        ),
        { id: "merging", name: "Merging", traits: [{ trait: "merge" }] },
      ],
    } as typeof RENAMED_IR;
    const finished = { ...shippedCard(), id: "FN-DONE", column: RENAMED_VOCAB.complete } as Task;
    const midMerge = { ...shippedCard(), id: "FN-MIDMERGE", column: "merging" } as Task;
    const waiting = {
      ...shippedCard(),
      id: "FN-WAITING",
      /*
      The HOLD lane is load-bearing. A card in the wip lane takes the sweep's `else` branch, which clears
      `blockedBy` without consulting `unresolvedDeps` at all — so the first version of this test passed
      with the satisfaction set widened. Eighth vacuous assertion here, eighth caught by the revert.
      Only the hold branch re-points the card at its next unmet dependency.
      */
      column: RENAMED_VOCAB.hold,
      blockedBy: "FN-DONE",
      dependencies: ["FN-MIDMERGE"],
    } as unknown as Task;
    const { store, transitionQueuedEpisode } = productionFaithfulStore([finished, midMerge, waiting]);
    Object.assign(store, {
      listWorkflowDefinitions: vi.fn(async () => [{ ir: splitReviewIr }]),
      getWorkflowDefinition: vi.fn(async (id: string) => (id === "self-healing-lifecycle" ? { ir: splitReviewIr } : undefined)),
    });

    await new SelfHealingManager(store, { rootDir: "/repo" }).reconcileCompletedTask("FN-DONE");

    // Its dependency is still merging, so the card is RE-POINTED at it rather than released.
    expect(transitionQueuedEpisode).toHaveBeenCalledWith(
      "FN-WAITING",
      expect.objectContaining({ blockedBy: "FN-MIDMERGE" }),
    );
  });
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, sixteenth sweep):
  A card that reached a terminal lane while still carrying `merging`/`merging-pr` holds the MERGER QUEUE.
  Two literal reads meant that on a renamed board the stale status was never cleared, so one finished
  card blocked every task queued behind it — the widest blast radius in this series, since the damage is
  not confined to the stranded card.

  REVERT CHECK, measured: with the literal reads restored, this fails — the card is never listed, so its
  stale status is never cleared and the queue stays blocked.
  */
  it("clears a stale merging status on a RENAMED terminal lane", async () => {
    const stale = {
      ...shippedCard(),
      id: "FN-STALEMERGE",
      column: RENAMED_VOCAB.complete,
      status: "merging",
    } as unknown as Task;
    const { store, updateTask } = productionFaithfulStore([stale]);

    await new SelfHealingManager(store, { rootDir: "/repo" }).reconcileStaleMergerStatus();

    expect(updateTask).toHaveBeenCalledWith("FN-STALEMERGE", expect.objectContaining({ status: null }));
  });
  it("leaves a card with no stale merging status alone", async () => {
    /*
    Non-vacuous companion: without it, a sweep that cleared the status of everything it found would
    satisfy the case above. Same board, same terminal lane — only the status differs.
    */
    const settled = { ...shippedCard(), id: "FN-SETTLED", column: RENAMED_VOCAB.complete, status: null } as unknown as Task;
    const { store, updateTask } = productionFaithfulStore([settled]);

    await new SelfHealingManager(store, { rootDir: "/repo" }).reconcileStaleMergerStatus();

    expect(updateTask).not.toHaveBeenCalled();
  });
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, seventeenth sweep):
  `recoverCompletedTasks` rescues a task whose steps are ALL done but whose session died before the
  executor could hand it to review. The literal read meant that on a renamed board it was never found:
  finished implementation work sat in the wip lane with no session and nothing to move it on.

  The observable is the injected `recoverCompletedTask` callback — called once per rescued card, with no
  git anywhere on the path, so it sits downstream of both the read and the per-card verdict.

  REVERT CHECKS, both measured, each alone:
    - literal read restored -> fails, the card is never listed
    - verdict back to `t.column === "in-progress"` -> fails, the renamed wip lane does not match
  */
  it("rescues a step-complete card stranded on a RENAMED wip lane", async () => {
    const stranded = {
      ...shippedCard(),
      id: "FN-STRANDED",
      column: RENAMED_VOCAB.wip,
      steps: [{ id: "s1", status: "done" }],
    } as unknown as Task;
    const { store } = productionFaithfulStore([stranded]);
    const recoverCompletedTask = vi.fn(async () => true);

    await new SelfHealingManager(store, { rootDir: "/repo", recoverCompletedTask }).recoverCompletedTasks();

    expect(recoverCompletedTask).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-STRANDED" }));
  });
  it("does not rescue a step-complete card that already reached the RENAMED review lane", async () => {
    /*
    Non-vacuous companion: without it, a read returning every column would satisfy the case above. Same
    board, same finished card — only its lane changes, and a card already in review needs no rescue.
    */
    const alreadyMoved = {
      ...shippedCard(),
      id: "FN-STRANDED",
      column: RENAMED_VOCAB.review,
      steps: [{ id: "s1", status: "done" }],
    } as unknown as Task;
    const { store } = productionFaithfulStore([alreadyMoved]);
    const recoverCompletedTask = vi.fn(async () => true);

    await new SelfHealingManager(store, { rootDir: "/repo", recoverCompletedTask }).recoverCompletedTasks();

    expect(recoverCompletedTask).not.toHaveBeenCalled();
  });
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, eighteenth sweep):
  `recoverInProgressLimbo` frees a card holding a wip slot with NO worktree, NO branch and no step
  started — nothing is running and nothing will. The literal read meant that on a renamed board it was
  never found, so the card kept its slot forever and denied that capacity to work that could run.

  Observable is `getFalsePositiveRequeueSignal`, a private method called once per stranded candidate. It
  runs BEFORE any lease or git work, so the assertion needs no fixture beyond the card itself.

  REVERT CHECKS, both measured, each alone:
    - literal read restored -> fails, the card is never listed
    - verdict back to `task.column !== "in-progress"` -> fails, the renamed wip lane is filtered out
  */
  it("frees a slot-holding limbo card on a RENAMED wip lane", async () => {
    const limbo = {
      ...shippedCard(),
      id: "FN-LIMBO",
      column: RENAMED_VOCAB.wip,
      worktree: null,
      branch: null,
      steps: [{ id: "s1", status: "pending" }],
      updatedAt: "2020-01-01T00:00:00.000Z",
    } as unknown as Task;
    const { store } = productionFaithfulStore([limbo]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });
    const signal = vi.fn(() => ({ reason: "executor-active", metadata: {} }));
    Object.assign(manager, {
      getFalsePositiveRequeueSignal: signal,
      emitFalsePositiveRequeueNoAction: vi.fn(async () => undefined),
    });

    await manager.recoverInProgressLimbo();

    expect(signal).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-LIMBO" }), expect.anything());
  });
  it("ignores a limbo-shaped card sitting in the RENAMED hold lane", async () => {
    /*
    Non-vacuous companion: a card with no worktree and no branch is the NORMAL shape in a hold lane —
    that is what a queued card looks like. Without this, a read returning every column would make the
    sweep reclaim cards that were never holding a slot at all.
    */
    const queued = {
      ...shippedCard(),
      id: "FN-LIMBO",
      column: RENAMED_VOCAB.hold,
      worktree: null,
      branch: null,
      steps: [{ id: "s1", status: "pending" }],
      updatedAt: "2020-01-01T00:00:00.000Z",
    } as unknown as Task;
    const { store } = productionFaithfulStore([queued]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });
    const signal = vi.fn(() => ({ reason: "executor-active", metadata: {} }));
    Object.assign(manager, {
      getFalsePositiveRequeueSignal: signal,
      emitFalsePositiveRequeueNoAction: vi.fn(async () => undefined),
    });

    await manager.recoverInProgressLimbo();

    expect(signal).not.toHaveBeenCalled();
  });
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, nineteenth sweep):
  `recoverOrphanedExecutions` takes NO lifecycle action — it emits `task:orphan-detected-no-action` so an
  operator can see a wip card with no live session behind it. The literal read meant that on a renamed
  board the event was never emitted, so the one signal pointing at an orphaned execution was silently
  absent. What this restores is visibility, not a repair.

  The observable is therefore the AUDITOR construction, which happens once per detected candidate.

  REVERT CHECKS, both measured, each alone:
    - literal read restored -> fails, the card is never listed
    - verdict back to `t.column !== "in-progress"` -> fails, the renamed wip lane is filtered out
  */
  it("emits the orphan-detected signal for a card on a RENAMED wip lane", async () => {
    const orphan = {
      ...shippedCard(),
      id: "FN-ORPHANEXEC",
      column: RENAMED_VOCAB.wip,
      worktree: null,
      steps: [{ id: "s1", status: "pending" }],
      updatedAt: "2020-01-01T00:00:00.000Z",
    } as unknown as Task;
    const { store } = productionFaithfulStore([orphan]);
    (createRunAuditor as unknown as ReturnType<typeof vi.fn>).mockClear();

    await new SelfHealingManager(store, { rootDir: "/repo" }).recoverOrphanedExecutions();

    expect(createRunAuditor).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ taskId: "FN-ORPHANEXEC", phase: "recover-orphaned-executions" }),
    );
  });
  it("does not emit the orphan signal for a card already in the RENAMED review lane", async () => {
    /*
    Non-vacuous companion: without it, a read returning every column would satisfy the case above. A card
    in review is not an orphaned EXECUTION — it has no slot and no session to be missing.
    */
    const reviewing = {
      ...shippedCard(),
      id: "FN-ORPHANEXEC",
      column: RENAMED_VOCAB.review,
      worktree: null,
      steps: [{ id: "s1", status: "pending" }],
      updatedAt: "2020-01-01T00:00:00.000Z",
    } as unknown as Task;
    const { store } = productionFaithfulStore([reviewing]);
    (createRunAuditor as unknown as ReturnType<typeof vi.fn>).mockClear();

    await new SelfHealingManager(store, { rootDir: "/repo" }).recoverOrphanedExecutions();

    expect(createRunAuditor).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ phase: "recover-orphaned-executions" }),
    );
  });
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, twentieth sweep):
  `reattachOrphanedAssignedExecutions` reattaches a DURABLE AGENT to a task it is still assigned to but
  has stopped executing. The literal read meant that on a renamed board the reattach never fired, so the
  card sat assigned-but-idle — visibly owned by an agent that had gone quiet, which is worse than
  unassigned because the board says someone is on it.

  Observable is the injected `resumeAssignedTaskForAgent`, called once per agent with orphaned work.

  REVERT CHECKS, both measured, each alone:
    - literal read restored -> fails, the card is never listed
    - verdict back to `task.column !== "in-progress"` -> fails, the renamed wip lane is skipped
  */
  function reattachFixture(column: string) {
    const assigned = {
      ...shippedCard(),
      id: "FN-REATTACH",
      column,
      assignedAgentId: "agent-1",
      worktree: null,
      steps: [{ id: "s1", status: "pending" }],
      updatedAt: "2020-01-01T00:00:00.000Z",
    } as unknown as Task;
    const { store } = productionFaithfulStore([assigned]);
    const resumeAssignedTaskForAgent = vi.fn(async () => undefined);
    const agentStore = {
      getAgent: vi.fn(async () => ({ id: "agent-1" })),
      getActiveHeartbeatRun: vi.fn(async () => null),
    };
    const manager = new SelfHealingManager(store, {
      rootDir: "/repo",
      agentStore: agentStore as never,
      resumeAssignedTaskForAgent,
    });
    return { manager, resumeAssignedTaskForAgent };
  }
  it("reattaches an idle assigned agent on a RENAMED wip lane", async () => {
    const { manager, resumeAssignedTaskForAgent } = reattachFixture(RENAMED_VOCAB.wip);

    await manager.reattachOrphanedAssignedExecutions();

    expect(resumeAssignedTaskForAgent).toHaveBeenCalledWith("agent-1");
  });
  it("does not reattach an agent whose card already reached the RENAMED review lane", async () => {
    /*
    Non-vacuous companion: without it, a read returning every column would satisfy the case above. An
    assigned card in review has finished its execution — resuming it would restart completed work.
    */
    const { manager, resumeAssignedTaskForAgent } = reattachFixture(RENAMED_VOCAB.review);

    await manager.reattachOrphanedAssignedExecutions();

    expect(resumeAssignedTaskForAgent).not.toHaveBeenCalled();
  });
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, twenty-second sweep):
  A GHOST review card is one parked in review past the stuck timeout with nobody owning its merge lane.
  The literal read meant that on a renamed board it was never found: no merger, no session, and no
  timeout ever firing against it.

  THE OBSERVABLE IS CHOSEN CAREFULLY. `isMergeLaneOwned` is called once per surviving candidate, AFTER
  the read and the per-card verdict — earlier on this branch I positioned this same spy UPSTREAM of the
  guard I was testing and it passed with the fix reverted. Here it sits downstream of both, which is the
  whole difference.

  `taskStuckTimeoutMs` must be set and `columnMovedAt` ancient, or the card is filtered out by the
  timeout rather than by lane, and the case would pass reverted for the wrong reason.

  REVERT CHECKS, both measured, each alone:
    - literal read restored -> fails, the card is never listed
    - verdict back to `task.column === "in-review"` -> fails, the renamed review lane is filtered out
  */
  function ghostFixture(column: string) {
    const ghost = {
      ...shippedCard(),
      id: "FN-GHOST",
      column,
      columnMovedAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
      mergeDetails: {},
    } as unknown as Task;
    const { store } = productionFaithfulStore([ghost]);
    Object.assign(store, {
      getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false, taskStuckTimeoutMs: 60_000 })),
    });
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });
    const isMergeLaneOwned = vi.fn(async () => true); // owned -> no kick-back, so nothing else has to be stubbed
    Object.assign(manager, { isMergeLaneOwned });
    return { manager, isMergeLaneOwned };
  }
  it("evaluates a ghost review card on a RENAMED review lane", async () => {
    const { manager, isMergeLaneOwned } = ghostFixture(RENAMED_VOCAB.review);

    await manager.recoverGhostReviewTasks();

    expect(isMergeLaneOwned).toHaveBeenCalledWith("FN-GHOST");
  });
  it("does not treat a long-idle card outside the review lanes as a ghost", async () => {
    /*
    Non-vacuous companion: without it, a read returning every column would satisfy the case above. A card
    idle in the HOLD lane is just queued — kicking it back would be the sweep inventing work.
    */
    const { manager, isMergeLaneOwned } = ghostFixture(RENAMED_VOCAB.hold);

    await manager.recoverGhostReviewTasks();

    expect(isMergeLaneOwned).not.toHaveBeenCalled();
  });
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, twenty-third sweep):
  `recoverTransientMergeFailures` refunds the retry budget for a merge that failed for a TRANSIENT reason
  and burned all its retries. The literal read meant that on a renamed board the refund never happened,
  so a card that failed on a network blip or a provider fault stayed failed permanently — visibly failed
  to the operator, with no visible cause.

  The error string is a REAL signature (`classifyTransientMergeError` matches "ACP turn failed"), not
  invented prose. An unrecognised string is filtered out one line later and the case would pass with the
  fix reverted — the same trap that produced the post-done wedge fixture's first failure.

  Observable is the injected `requeueForAutoMerge`, called once per recovered card.

  REVERT CHECKS, both measured, each alone:
    - literal read restored -> fails, the card is never listed
    - verdict back to `t.column === "in-review"` -> fails, the renamed review lane is filtered out
  */
  function transientFixture(column: string) {
    const failed = {
      ...shippedCard(),
      id: "FN-TRANSIENT",
      column,
      status: "failed",
      mergeRetries: 99,
      error: "ACP turn failed while merging",
    } as unknown as Task;
    const { store } = productionFaithfulStore([failed]);
    const requeueForAutoMerge = vi.fn(async () => true);
    const manager = new SelfHealingManager(store, { rootDir: "/repo", requeueForAutoMerge });
    return { manager, requeueForAutoMerge };
  }
  it("refunds a transient merge failure on a RENAMED review lane", async () => {
    const { manager, requeueForAutoMerge } = transientFixture(RENAMED_VOCAB.review);

    await manager.recoverTransientMergeFailures();

    expect(requeueForAutoMerge).toHaveBeenCalled();
  });
  it("does not refund a transient failure for a card outside the review lanes", async () => {
    /*
    Non-vacuous companion: without it, a read returning every column would satisfy the case above. A
    failed card in the wip lane has not reached merge at all — there is no merge budget to refund.
    */
    const { manager, requeueForAutoMerge } = transientFixture(RENAMED_VOCAB.wip);

    await manager.recoverTransientMergeFailures();

    expect(requeueForAutoMerge).not.toHaveBeenCalled();
  });
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, twenty-fourth sweep):
  `recoverStaleIncompleteReviewTasks` requeues a review card whose STEPS are not finished — it reached
  review on a graph failure, not on completed work. The literal read meant that on a renamed board it was
  never requeued: the card sat in review claiming to be done while its own steps said otherwise.

  Observable is `evaluateBackwardMoveTripleProof`, private and called once per candidate BEFORE the move,
  so no git fixture is needed. `taskStuckTimeoutMs` is set and a step left non-terminal, or the card is
  filtered out for reasons unrelated to lanes.

  REVERT CHECKS, both measured, each alone:
    - literal read restored -> fails, the card is never listed
    - verdict back to `task.column === "in-review"` -> fails, the renamed review lane is filtered out
  */
  function staleIncompleteFixture(column: string) {
    const card = {
      ...shippedCard(),
      id: "FN-INCOMPLETE",
      column,
      status: "failed",
      steps: [{ id: "s1", status: "in-progress" }],
      columnMovedAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
    } as unknown as Task;
    const { store } = productionFaithfulStore([card]);
    Object.assign(store, {
      getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false, taskStuckTimeoutMs: 60_000 })),
    });
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });
    const proof = vi.fn(async () => ({ ok: false, reason: "test" }));
    Object.assign(manager, {
      evaluateBackwardMoveTripleProof: proof,
      emitBackwardMoveNoAction: vi.fn(async () => undefined),
    });
    return { manager, proof };
  }
  it("requeues a step-incomplete card on a RENAMED review lane", async () => {
    const { manager, proof } = staleIncompleteFixture(RENAMED_VOCAB.review);

    await manager.recoverStaleIncompleteReviewTasks();

    expect(proof).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-INCOMPLETE" }), expect.anything());
  });
  it("leaves a step-incomplete card in the RENAMED wip lane alone", async () => {
    /*
    Non-vacuous companion: a card with unfinished steps in the WIP lane is not stale — it is simply being
    worked on. A read returning every column would requeue live work.
    */
    const { manager, proof } = staleIncompleteFixture(RENAMED_VOCAB.wip);

    await manager.recoverStaleIncompleteReviewTasks();

    expect(proof).not.toHaveBeenCalled();
  });
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, twenty-fifth sweep):
  `recoverMisclassifiedFailures` clears a failure the executor parked for "without calling fn_task_done"
  on a task whose steps are ALL actually done — the failure is a misclassification, not real work left
  undone. The literal read meant that on a renamed board it was never cleared, so finished work stayed
  visibly failed and never entered normal review.

  The error string must contain the REAL phrase `isNoTaskDoneFailure` matches. Invented prose is filtered
  out one line later and the case would pass with the fix reverted — the same trap as #2916's fixture.

  REVERT CHECKS, both measured, each alone:
    - literal read restored -> fails, the card is never listed
    - verdict back to `t.column === "in-review"` -> fails, the renamed review lane is filtered out
  */
  function misclassifiedFixture(column: string) {
    const card = {
      ...shippedCard(),
      id: "FN-MISCLASS",
      column,
      status: "failed",
      error: "Agent finished without calling fn_task_done",
      steps: [{ id: "s1", status: "done" }],
    } as unknown as Task;
    return productionFaithfulStore([card]);
  }
  it("clears a misclassified failure on a RENAMED review lane", async () => {
    const { store, updateTask } = misclassifiedFixture(RENAMED_VOCAB.review);

    await new SelfHealingManager(store, { rootDir: "/repo" }).recoverMisclassifiedFailures();

    expect(updateTask).toHaveBeenCalledWith("FN-MISCLASS", expect.objectContaining({ status: null, error: null }));
  });
  it("does not clear the same failure for a card in the RENAMED wip lane", async () => {
    /*
    Non-vacuous companion: without it, a read returning every column would satisfy the case above. A card
    still in wip has not handed off, so clearing its failure would hide a live problem.
    */
    const { store, updateTask } = misclassifiedFixture(RENAMED_VOCAB.wip);

    await new SelfHealingManager(store, { rootDir: "/repo" }).recoverMisclassifiedFailures();

    expect(updateTask).not.toHaveBeenCalled();
  });
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, twenty-sixth sweep):
  `recoverBranchMisboundInReviewTasks` detects a review card whose BRANCH TIP is bound to a different
  task's work. The literal read meant that on a renamed board the misbinding was never detected, so the
  card would merge — or refuse to — against a branch that is not its own.

  Observable is `resolveSelfHealingMergeTarget`, private and called once per candidate, so the assertion
  sits downstream of both halves without a git fixture.

  REVERT CHECKS, both measured, each alone:
    - literal read restored -> fails, the card is never listed
    - verdict back to `task.column === "in-review"` -> fails, the renamed review lane is filtered out
  */
  function misboundFixture(column: string) {
    const card = {
      ...shippedCard(),
      id: "FN-MISBOUND",
      column,
      branch: "fusion/FN-MISBOUND",
      mergeDetails: {},
    } as unknown as Task;
    const { store } = productionFaithfulStore([card]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });
    const resolveTarget = vi.fn(async () => ({ branch: "main", source: "settings" }));
    Object.assign(manager, {
      resolveSelfHealingMergeTarget: resolveTarget,
      isBranchTipMisboundToTask: vi.fn(async () => ({ rejection: null, branchTip: "abc1234" })),
    });
    return { manager, resolveTarget };
  }
  it("checks branch binding for a card on a RENAMED review lane", async () => {
    const { manager, resolveTarget } = misboundFixture(RENAMED_VOCAB.review);

    await manager.recoverBranchMisboundInReviewTasks();

    expect(resolveTarget).toHaveBeenCalledWith(
      expect.objectContaining({ id: "FN-MISBOUND" }),
      expect.anything(),
      "recover-branch-misbound-in-review",
    );
  });
  it("does not check branch binding for a card in the RENAMED wip lane", async () => {
    /*
    Non-vacuous companion: a card still in wip legitimately owns a moving branch tip — checking it here
    would flag normal in-progress work as misbound.
    */
    const { manager, resolveTarget } = misboundFixture(RENAMED_VOCAB.wip);

    await manager.recoverBranchMisboundInReviewTasks();

    expect(resolveTarget).not.toHaveBeenCalled();
  });
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, twenty-seventh sweep):
  `recoverMissingWorktreeReviewFailures` requeues a review card failed because its worktree was gone when
  the session tried to start. Its per-candidate lane wiring was already in place — and a note at the site
  called the literal QUERY above it "unfixable without a project-level lane resolution before the read".
  `resolveProjectColumnsForRoles` is that resolution; it did not exist when the note was written. So the
  wiring only ever helped boards whose review lane still happened to be named `in-review`.

  The error string uses a REAL prefix from MISSING_WORKTREE_SESSION_PREFIXES; invented prose is rejected
  by `isMissingWorktreeSessionStartFailure` and the case would pass with the fix reverted.

  REVERT CHECK, measured: with the literal read restored, this fails — the card is never listed.
  */
  it("requeues a missing-worktree review failure on a RENAMED review lane", async () => {
    const card = {
      ...shippedCard(),
      id: "FN-NOWT",
      column: RENAMED_VOCAB.review,
      status: "failed",
      error: "Refusing to start coding agent in missing worktree: /tmp/gone",
      steps: [{ id: "s1", status: "pending" }],
    } as unknown as Task;
    const { store } = productionFaithfulStore([card]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });
    const proof = vi.fn(async () => ({ ok: false, reason: "test" }));
    Object.assign(manager, {
      evaluateBackwardMoveTripleProof: proof,
      emitBackwardMoveNoAction: vi.fn(async () => undefined),
    });

    await manager.recoverMissingWorktreeReviewFailures();

    expect(proof).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-NOWT" }), expect.anything());
  });
  it("resolves the review lanes as a MEMBERSHIP set, not just the first one", async () => {
    /*
    The arity half. The per-candidate set was built from `resolveTaskLifecycleColumns().review`, which is
    the FIRST column per role — so on a board declaring a separate merge lane beside its human-review
    lane, a card in the second one read as not-in-review and was skipped. This drives exactly that board.

    REVERT CHECK, measured: with the set back to `new Set([lifecycle?.review ?? "in-review", "in-review"])`
    this fails — the card in the second review column is never classified as recoverable.
    */
    const splitReviewIr = {
      ...RENAMED_IR,
      columns: [
        ...RENAMED_IR.columns,
        { id: "merging", name: "Merging", traits: [{ trait: "merge" }] },
      ],
    } as typeof RENAMED_IR;
    const card = {
      ...shippedCard(),
      id: "FN-NOWT2",
      column: "merging",
      status: "failed",
      error: "Refusing to start coding agent in missing worktree: /tmp/gone",
      steps: [{ id: "s1", status: "pending" }],
    } as unknown as Task;
    const { store } = productionFaithfulStore([card]);
    Object.assign(store, {
      listWorkflowDefinitions: vi.fn(async () => [{ ir: splitReviewIr }]),
      getWorkflowDefinition: vi.fn(async (id: string) => (id === "self-healing-lifecycle" ? { ir: splitReviewIr } : undefined)),
    });
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });
    const proof = vi.fn(async () => ({ ok: false, reason: "test" }));
    Object.assign(manager, {
      evaluateBackwardMoveTripleProof: proof,
      emitBackwardMoveNoAction: vi.fn(async () => undefined),
    });

    await manager.recoverMissingWorktreeReviewFailures();

    expect(proof).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-NOWT2" }), expect.anything());
  });
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, twenty-eighth sweep):
  `auditNoCommitsExpectedCandidates` flags a card that finished every step and pushed NO commits — either
  a legitimately commit-free task nobody declared as such, or work that silently produced nothing.

  The literal read meant that on a renamed board only the `no_commits` ERROR path fed the audit, so a card
  sitting quietly in a renamed review lane with zero commits and no error was never flagged. The sweep
  did not go dead — it went half-blind, which is harder to notice.

  REVERT CHECK, measured: with the literal read and verdict restored, this fails — the card contributes
  nothing, because it has no `no_commits` error to be caught by the other arm.
  */
  it("flags a zero-commit card on a RENAMED review lane with no error text", async () => {
    const card = {
      ...shippedCard(),
      id: "FN-NOCOMMITS",
      column: RENAMED_VOCAB.review,
      status: null,
      error: null,
      steps: [{ id: "s1", status: "done" }],
    } as unknown as Task;
    const { store } = productionFaithfulStore([card]);
    isBranchAheadOfBase.mockClear();

    const flagged = await new SelfHealingManager(store, { rootDir: "/repo" }).auditNoCommitsExpectedCandidates();

    expect(isBranchAheadOfBase).toHaveBeenCalled();
    expect(flagged).toBe(1);
  });
  it("does not flag a zero-commit card that already declared noCommitsExpected", async () => {
    /*
    Non-vacuous companion: without it, a sweep flagging every zero-commit card it found would satisfy the
    case above. Same board, same lane — only the declaration differs, which is the whole point of the flag.
    */
    const card = {
      ...shippedCard(),
      id: "FN-NOCOMMITS",
      column: RENAMED_VOCAB.review,
      status: null,
      error: null,
      noCommitsExpected: true,
      steps: [{ id: "s1", status: "done" }],
    } as unknown as Task;
    const { store } = productionFaithfulStore([card]);
    isBranchAheadOfBase.mockClear();

    const flagged = await new SelfHealingManager(store, { rootDir: "/repo" }).auditNoCommitsExpectedCandidates();

    expect(isBranchAheadOfBase).not.toHaveBeenCalled();
    expect(flagged).toBe(0);
  });
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, twenty-ninth sweep):
  `recoverNoProgressNoTaskDoneFailures` requeues a wip card the executor failed for "no fn_task_done"
  that made NO step progress and left no git work — nothing to salvage, so requeueing is safe. The
  literal read meant that on a renamed board it was never requeued: a card that produced nothing sat
  failed while still holding its wip slot.

  Observable is `hasRecoverableGitWork`, private and called once per candidate before any requeue, so no
  git fixture is needed. The error string carries the REAL phrase `isNoTaskDoneFailure` matches.

  REVERT CHECKS, both measured, each alone:
    - literal read restored -> fails, the card is never listed
    - verdict back to `task.column === "in-progress"` -> fails, the renamed wip lane is filtered out
  */
  function noProgressFixture(column: string) {
    const card = {
      ...shippedCard(),
      id: "FN-NOPROGRESS",
      column,
      status: "failed",
      error: "Agent finished without calling fn_task_done",
      steps: [{ id: "s1", status: "pending" }],
    } as unknown as Task;
    const { store } = productionFaithfulStore([card]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });
    const hasRecoverableGitWork = vi.fn(async () => true); // true -> sweep leaves it alone, so nothing else needs stubbing
    Object.assign(manager, { hasRecoverableGitWork });
    return { manager, hasRecoverableGitWork };
  }
  it("considers a no-progress failure on a RENAMED wip lane", async () => {
    const { manager, hasRecoverableGitWork } = noProgressFixture(RENAMED_VOCAB.wip);

    await manager.recoverNoProgressNoTaskDoneFailures();

    expect(hasRecoverableGitWork).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-NOPROGRESS" }));
  });
  it("does not consider the same failure once the card reached the RENAMED review lane", async () => {
    /*
    Non-vacuous companion: a card in review has handed off; requeueing it from here would undo a
    completed hand-off rather than rescue a stalled one.
    */
    const { manager, hasRecoverableGitWork } = noProgressFixture(RENAMED_VOCAB.review);

    await manager.recoverNoProgressNoTaskDoneFailures();

    expect(hasRecoverableGitWork).not.toHaveBeenCalled();
  });
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, thirtieth sweep):
  `recoverPartialProgressNoTaskDoneFailures` retries a review card failed for "no fn_task_done" that DID
  make step progress. Real work exists, so the sweep spends a retry rather than discarding it. The
  literal read meant that on a renamed board the retry never fired: partially-completed work was parked
  failed with its retry budget untouched — a budget that exists precisely to avoid losing that work.

  A step must be `done` (hasStepProgress) while another is not, or the card is filtered out by
  `isTaskWorkComplete` for a reason unrelated to lanes.

  REVERT CHECKS, both measured, each alone:
    - literal read restored -> fails, the card is never listed
    - verdict back to `task.column === "in-review"` -> fails, the renamed review lane is filtered out
  */
  function partialFixture(column: string) {
    const card = {
      ...shippedCard(),
      id: "FN-PARTIAL",
      column,
      status: "failed",
      error: "Agent finished without calling fn_task_done",
      steps: [{ id: "s1", status: "done" }, { id: "s2", status: "pending" }],
      columnMovedAt: "2020-01-01T00:00:00.000Z",
    } as unknown as Task;
    const { store } = productionFaithfulStore([card]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });
    const proof = vi.fn(async () => ({ ok: false, reason: "test" }));
    Object.assign(manager, {
      evaluateBackwardMoveTripleProof: proof,
      emitBackwardMoveNoAction: vi.fn(async () => undefined),
    });
    return { manager, proof };
  }
  it("retries a partial-progress failure on a RENAMED review lane", async () => {
    const { manager, proof } = partialFixture(RENAMED_VOCAB.review);

    await manager.recoverPartialProgressNoTaskDoneFailures();

    expect(proof).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-PARTIAL" }), expect.anything());
  });
  it("does not retry the same failure while the card is still in the RENAMED wip lane", async () => {
    /*
    Non-vacuous companion: a card still in wip has not finished its attempt, so spending a retry from
    here would burn the budget on work that is still running.
    */
    const { manager, proof } = partialFixture(RENAMED_VOCAB.wip);

    await manager.recoverPartialProgressNoTaskDoneFailures();

    expect(proof).not.toHaveBeenCalled();
  });
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, thirty-first sweep):
  `recoverDoneTaskMergeMetadata` repairs the merge metadata of a card that already reached the COMPLETE
  lane — the commit sha an operator sees, and that later reconcilers trust. The literal read meant that
  on a renamed board a done card's metadata was never repaired, so a completed task could keep pointing
  at a commit that is not the one that landed.

  Scoped to `complete`, NOT the terminal union: an archived card is out of scope, and widening to
  TERMINAL_ROLES would start repairing rows nobody reads — a behaviour change wearing a conversion's
  clothes. The companion case pins that.

  REVERT CHECKS, both measured, each alone:
    - literal read restored -> fails, the card is never listed
    - verdict back to `task.column !== "done"` -> fails, the renamed complete lane is filtered out
  */
  function doneMetaFixture(column: string) {
    const card = {
      ...shippedCard(),
      id: "FN-DONEMETA",
      column,
      mergeDetails: { mergeConfirmed: true, commitSha: "abcdef1234567890" },
    } as unknown as Task;
    const { store } = productionFaithfulStore([card]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });
    const findLandedTaskCommit = vi.fn(async () => null);
    Object.assign(manager, { findLandedTaskCommit });
    return { manager, findLandedTaskCommit };
  }
  it("repairs merge metadata on a RENAMED complete lane", async () => {
    const { manager, findLandedTaskCommit } = doneMetaFixture(RENAMED_VOCAB.complete);

    await manager.recoverDoneTaskMergeMetadata();

    expect(findLandedTaskCommit).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-DONEMETA" }));
  });
  it("does not touch a card in the RENAMED review lane", async () => {
    /*
    Non-vacuous companion: without it, a read returning every column would satisfy the case above. A card
    still in review has not landed, so "repairing" its merge metadata would invent an answer.
    */
    const { manager, findLandedTaskCommit } = doneMetaFixture(RENAMED_VOCAB.review);

    await manager.recoverDoneTaskMergeMetadata();

    expect(findLandedTaskCommit).not.toHaveBeenCalled();
  });
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, sweeps thirty-three and -four):
  The two WORKSPACE sweeps. A workspace task lands PER-REPO, so its failure modes are its own: a
  partial land leaves some repos merged and some not, and a finished one leaves per-repo worktrees on
  disk. Both were bounded by literal reads, so on a renamed board neither ran — the partial land never
  finished, and the disk was never reclaimed.

  `isWorkspaceTaskLive` is what the partial-land sweep calls once per surviving candidate, before any
  git or disk work — the private-seam technique, so no workspace fixture is needed.

  REVERT CHECKS, both measured, each alone:
    - partial-land literal read + verdict restored -> that case fails, the card is never listed
    - orphaned-worktree literal read restored -> that case fails, the done card is never listed
  */
  function workspaceCard(id: string, column: string): Task {
    return {
      ...shippedCard(),
      id,
      column,
      workspaceRepos: [{ path: "repo-a" }],
      workspaceWorktrees: { "repo-a": { worktreePath: "/tmp/ws/repo-a" } },
      mergeDetails: {},
    } as unknown as Task;
  }
  it("re-enqueues a partially-landed workspace task on a RENAMED review lane", async () => {
    const { store } = productionFaithfulStore([workspaceCard("FN-WSPARTIAL", RENAMED_VOCAB.review)]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });
    const isWorkspaceTaskLive = vi.fn(() => ({ live: true, livePaths: ["/tmp/ws/repo-a"] }));
    Object.assign(manager, { isWorkspaceTaskLive, emitWorkspacePartialLandNoAction: vi.fn(async () => undefined) });

    await manager.reconcileWorkspacePartialLands();

    expect(isWorkspaceTaskLive).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-WSPARTIAL" }));
  });
  it("does not re-enqueue a workspace task still in the RENAMED wip lane", async () => {
    /*
    Non-vacuous companion: a workspace task in wip has not started landing, so there is no partial land
    to finish — the comment at the site says execution-stage reconcilers own that lane.
    */
    const { store } = productionFaithfulStore([workspaceCard("FN-WSPARTIAL", RENAMED_VOCAB.wip)]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });
    const isWorkspaceTaskLive = vi.fn(() => ({ live: true, livePaths: ["/tmp/ws/repo-a"] }));
    Object.assign(manager, { isWorkspaceTaskLive, emitWorkspacePartialLandNoAction: vi.fn(async () => undefined) });

    await manager.reconcileWorkspacePartialLands();

    expect(isWorkspaceTaskLive).not.toHaveBeenCalled();
  });
  it("cleans orphaned workspace worktrees for a card on a RENAMED complete lane", async () => {
    const { store } = productionFaithfulStore([workspaceCard("FN-WSDONE", RENAMED_VOCAB.complete)]);
    const listTasksSpy = (store as unknown as { listTasks: ReturnType<typeof vi.fn> }).listTasks;
    listTasksSpy.mockClear();

    await new SelfHealingManager(store, { rootDir: "/repo" }).reconcileOrphanedWorkspaceWorktrees();

    /*
    The sweep's disk work is guarded by `isPathActive` and real fs checks, so the honest observable is
    that it ASKED for the board's own complete lane at all — nothing downstream vetoes on lane here
    (the only filter is `isWorkspaceTask`), which is what makes a query assertion sound rather than lazy.
    */
    const queried = listTasksSpy.mock.calls.map(([options]) => (options as { column?: string })?.column);
    expect(queried).toContain(RENAMED_VOCAB.complete);
  });
});


/*
FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (#2867 review — greptile, "hard-blocker wiring remains
untested"):

THE WIRING, TESTED AT THE SEAM RATHER THAN THROUGH THE SWEEP.

`recoverAlreadyMergedReviewTasks` calls `getTaskHardMergeBlocker(..., { reviewColumns: await
ownReviewLanesForAlreadyMerged(task) })`. The sweep test above stops at candidacy, and the note there
defended the gap as "type-checked and identical to a shape proven elsewhere". Type-checking cannot see
it: `reviewColumns` is an OPTIONAL property on an options object, so omitting it compiles. The
inert-seam gate cannot see it either — it tracks trailing optional PARAMETERS, not options-bag
properties. Nothing was watching the argument from either direction.

Driving the sweep to that line needs `resolveSelfHealingMergeTarget` and `findAlreadyMergedTaskCommit`
to succeed, i.e. a real git repo, which would make this a git fixture rather than a lane test. So the
seam is asserted directly: with the card's resolved lanes supplied there is no blocker, and without
them the same card blocks — reproducing the production symptom exactly, an already-merged card on a
renamed board failed with "Merge confirmed but finalization blocked", the sweep's purpose inverted.

WHAT THIS STILL DOES NOT COVER, MEASURED RATHER THAN ASSUMED. I deleted the `reviewColumns` argument
from the sweep's call site and these three cases stayed GREEN. They pin the SEAM's behaviour, not the
producer that fills it — the same guard-versus-resolver split that made the planner-metrics option
inert in #2842, where only a test driving the PRODUCER caught the omission.

So this is an improvement over the claim it replaces ("type-checked and identical to a shape proven
elsewhere", which was unfounded — an optional options-bag property compiles when omitted and the
inert-seam gate does not track those), but it is not coverage of the wiring. Covering that needs a
test that drives `recoverAlreadyMergedReviewTasks` far enough to reach the call, which needs
`resolveSelfHealingMergeTarget` and `findAlreadyMergedTaskCommit` to succeed against a real repo.
Stated here so the next reader does not mistake three green cases for a watched argument.
*/
describe("the already-merged hard blocker judges the card's OWN review lanes", () => {
  const mergedCard = (column: string) => ({
    id: "FN-HARD",
    column,
    status: "failed" as const,
    paused: false,
    steps: [],
    workflowStepResults: [],
  });

  it("does NOT block an already-merged card in a RENAMED review lane when its lanes are supplied", () => {
    const blocker = getTaskHardMergeBlocker(mergedCard(RENAMED_VOCAB.review), {
      reviewColumns: new Set([RENAMED_VOCAB.review]),
    });

    expect(blocker).toBeUndefined();
  });

  it("DOES block the same card when the lanes are omitted — the symptom if the wiring is dropped", () => {
    const blocker = getTaskHardMergeBlocker(mergedCard(RENAMED_VOCAB.review));

    /* The message the operator would see behind "Merge confirmed but finalization blocked". */
    expect(blocker).toContain("must be in 'in-review'");
  });

  it("still blocks a card that is genuinely outside its board's review lanes", () => {
    /*
    The paired negative. Wiring the resolved lanes must not degrade into "never blocks" — that would
    finalize a merge for a card sitting in WIP.
    */
    const blocker = getTaskHardMergeBlocker(mergedCard(RENAMED_VOCAB.wip), {
      reviewColumns: new Set([RENAMED_VOCAB.review]),
    });

    expect(blocker).toContain(`must be in '${RENAMED_VOCAB.review}'`);
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-16:25 (RESTORED alongside the wiring it proves):
  `surfaceInReviewStalls` tells an operator a card is stalled in review. #2951 converted its READ to the
  project's review columns but its bulk conflict resolution dropped the per-card `reviewColumns`
  argument — and dropped THIS TEST in the same pass, which is why the regression landed silently. A
  deleted test cannot fail, so the gate stayed green over a sweep that resolves lanes and then surfaces
  nothing on a renamed board.

  REVERT CHECKS, both measured, each alone:
    - literal read restored               -> fails, the card is never listed
    - `reviewColumns` dropped at the call -> fails, the classifier judges the renamed lane by the
      literal and returns no signal
  */
  it("surfaces a stalled card on a RENAMED review lane", async () => {
    const stalled = {
      ...shippedCard(),
      id: "FN-STALLED",
      column: RENAMED_VOCAB.review,
      status: "failed",
      error: "merge failed: conflict",
      mergeRetries: 99,
      mergeDetails: {},
      updatedAt: "2020-01-01T00:00:00.000Z",
    } as unknown as Task;
    const { store } = productionFaithfulStore([stalled]);
    Object.assign(store, {
      getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false, taskStuckTimeoutMs: 60_000 })),
    });

    /* The sweep surfaces by LOGGING and only writes for specific terminal codes, so its own count is
       the observable — asserting a write would pin a different branch than the lane read. */
    const surfaced = await new SelfHealingManager(store, { rootDir: "/repo" }).surfaceInReviewStalls();

    expect(surfaced).toBeGreaterThan(0);
  });

  it("does not surface a stall for a card outside the review lanes", async () => {
    /*
    Non-vacuous companion: the same failed card in the WIP lane has not reached review, so reporting a
    stall there would invent one.
    */
    const stalled = {
      ...shippedCard(),
      id: "FN-STALLED",
      column: RENAMED_VOCAB.wip,
      status: "failed",
      error: "merge failed: conflict",
      mergeRetries: 99,
      mergeDetails: {},
      updatedAt: "2020-01-01T00:00:00.000Z",
    } as unknown as Task;
    const { store } = productionFaithfulStore([stalled]);
    Object.assign(store, {
      getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false, taskStuckTimeoutMs: 60_000 })),
    });

    const surfaced = await new SelfHealingManager(store, { rootDir: "/repo" }).surfaceInReviewStalls();

    expect(surfaced).toBe(0);
  });

});