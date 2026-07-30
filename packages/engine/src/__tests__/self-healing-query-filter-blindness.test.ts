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

  it("KNOWN DEFECT: the done-integrity sweep asks for the literal `done`, so a RENAMED board yields nothing", async () => {
    /*
    `reconcileDoneTaskIntegrity` opens with `listTasks({ column: "done", slim: true })` and then
    re-asserts `task.column === "done"` on the rows it gets back. The census counts that re-assertion;
    converting it would drop a count and change nothing, because the list was already empty.

    The card below HAS landed and HAS modified files with no recorded commit sha — exactly the state the
    sweep exists to repair. It sits in `shipped`, so the store returns no rows and the repair never runs.
    */
    const { store, listTasks } = productionFaithfulStore([shippedCard()]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    expect(await manager.reconcileDoneTaskIntegrity()).toBe(0);

    // The query asked for the legacy literal, NOT this workflow's resolved complete lane.
    expect(listTasks).toHaveBeenCalledWith(expect.objectContaining({ column: "done" }));
    expect(listTasks).not.toHaveBeenCalledWith(expect.objectContaining({ column: RENAMED_VOCAB.complete }));

    // And the card is untouched: still no commit sha, still unreconciled.
    expect((await store.getTask("FN-BLIND"))?.mergeDetails?.commitSha).toBeUndefined();
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
    const permissiveList = vi.fn(async () => [card]);

    const rows = await permissiveList();

    expect(rows).toHaveLength(1);
    expect(rows[0].column).toBe(RENAMED_VOCAB.complete);
    expect(rows[0].column).not.toBe("done");
  });
});
