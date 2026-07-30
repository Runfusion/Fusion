/*
FNXC:WorkflowScheduling 2026-07-31-07:10 (E2E evidence — the optional-role-parameter class, third instance):

Third measured instance of the pattern from #2795 and #2798, and the sharpest form of it: the
converted and unconverted call sites are in the SAME FILE, and one is nested inside the other's call
tree.

`in-process-runtime.ts` resolves terminal columns through an optional parameter defaulting to the
legacy pair (`done` + `archived`). Three internal call sites:

  drainDuePlanningContinuations:386        passes { terminalColumns }              CONVERTED
  selectActionablePlanningContinuations:413 passes NOTHING                         unconverted
  resolvePlanningContinuationCandidate:199  calls the inner dispatchable predicate
                                            without threading its own set          unconverted

WHAT BREAKS. `selectActionablePlanningContinuations` documents its own purpose as excluding
"soft-deleted / archived / done tasks so archive-fallback rows returned by getTask cannot re-enter
plan-review after the card left the board". On a renamed board its terminal check is against ids that
board does not have, so a card sitting in its COMPLETE column is classified `actionable` and re-enters
plan-review — precisely the thing the function exists to prevent, silently, on every custom board.

The third site is subtler and worth naming because it shows the conversion is not even whole along
the converted path: `resolvePlanningContinuationCandidate` applies the caller's resolved set to its
own terminal test, then delegates to `isPlanningContinuationTaskDispatchable(task)` WITHOUT passing
it, so that inner predicate re-tests against the legacy pair. A partially threaded conversion is
indistinguishable from a complete one at every call site that looks converted.

WHY THE CENSUS CANNOT SEE ANY OF IT. There is no column literal at the unconverted call sites — the
literal is `LEGACY_TERMINAL_PAIR`, one function away, where it is correct for an unconverted caller
and correctly annotated. Same mechanism as #2795 and #2798; this file adds the intra-file variant.

SCOPE, STATED HONESTLY. The behavioural cases are driven end to end with real persisted rows from a
live PostgreSQL store and the real exported functions. The call-site split is asserted against source
text — driving the drain needs the runtime's full dependency set, which I did not build — and the
audit case says so rather than dressing it up.

LANE. `.pg.test.ts`, skipped via `pgDescribe` when no PostgreSQL is reachable, so the merge gate is
unaffected. Throwaway per-file database; never port 4040.
*/
import { beforeAll, beforeEach, afterEach, afterAll, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import "@fusion/core"; // registers the built-in column traits
import type { Task, TaskStore, WorkflowWorkItem } from "@fusion/core";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";

import {
  resolvePlanningContinuationCandidate,
  selectActionablePlanningContinuations,
} from "../runtimes/in-process-runtime.js";
import { DEFAULT_VOCAB, RENAMED_VOCAB, lifecycleIr, type Vocabulary } from "./_workflow-vocabulary-fixture.js";

/** A due planning continuation for a task. Only the fields the classifier reads matter. */
function planningItem(taskId: string): WorkflowWorkItem {
  return {
    id: `WI-${taskId}`,
    runId: "RUN-1",
    taskId,
    nodeId: "plan",
    kind: "node",
    state: "pending",
    attempt: 0,
    retryAfter: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastError: null,
    blockedReason: null,
    stableWorkflowRunId: null,
    continuationSequence: 1,
    waitReason: "planning",
    sourceColumn: null,
    targetColumn: null,
    irHash: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as WorkflowWorkItem;
}

pgDescribe("planning-continuation terminal columns, measured on a live store", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_plan_cont",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => { await h.beforeEach(); });
  afterEach(async () => { await h.afterEach(); });

  /** A real persisted card parked in its workflow's COMPLETE column — a card that has left the board. */
  async function completedCard(store: TaskStore, v: Vocabulary, key: string): Promise<Task> {
    const created = await store.createWorkflowDefinition({
      name: `Cont ${key}`,
      kind: "workflow",
      ir: lifecycleIr(v, `custom:${key}`),
    } as never);
    const workflowId = (created as { id: string }).id;

    const task = await store.createTask({ description: `continuation probe ${key}` });
    await store.writeTaskWorkflowSelection(task.id, workflowId, []);
    store.taskCache.delete(task.id);
    await store.moveTask(task.id, v.complete as never, { recoveryRehome: true } as never);

    store.taskCache.delete(task.id);
    const row = await store.getTask(task.id);
    if (!row) throw new Error("fixture: card not persisted");
    return row;
  }

  it("CONTROL — on the DEFAULT board a completed card is correctly excluded", async () => {
    /* The legacy default is right here, which is why the omission went unnoticed. */
    const store = h.store();
    const card = await completedCard(store, DEFAULT_VOCAB, "wf-default-cont");

    expect(card.column).toBe(DEFAULT_VOCAB.complete); // ...which is literally "done"
    expect(selectActionablePlanningContinuations([{ item: planningItem(card.id), task: card }])).toEqual([]);
  });

  it("CHARACTERIZATION — on a RENAMED board a completed card re-enters plan-review", async () => {
    /*
    The card has left the board: it sits in its workflow's COMPLETE column. The function whose stated
    job is to stop exactly this returns it as actionable, because its terminal test is against ids
    this board does not contain.
    */
    const store = h.store();
    const card = await completedCard(store, RENAMED_VOCAB, "wf-renamed-cont");

    expect(card.column).toBe(RENAMED_VOCAB.complete);
    const actionable = selectActionablePlanningContinuations([{ item: planningItem(card.id), task: card }]);

    expect(actionable).toHaveLength(1);
    expect(actionable[0]?.task.id).toBe(card.id);
  });

  it("BOUND — the SAME card is an orphan once the resolved terminal columns are passed", async () => {
    /* Attributes the failure above to the call shape and nothing else: identical card, identical
       classifier, one extra argument — what the drain's converted call site does. */
    const store = h.store();
    const card = await completedCard(store, RENAMED_VOCAB, "wf-renamed-resolved");

    const resolved = resolvePlanningContinuationCandidate(planningItem(card.id), card, {
      terminalColumns: new Set([RENAMED_VOCAB.complete]),
    });

    expect(resolved.kind).toBe("orphan");
    expect(resolved.kind === "orphan" ? resolved.reason : null).toBe("task-terminal");
  });

  it("AUDIT — one of the two classifier call sites is converted, and the inner predicate is not", async () => {
    /*
    NOT driven: reaching the drain needs the runtime's full dependency set. Asserted against source
    text and labelled as such.

    An alarm in both directions, like #2798's: converting the remaining site fails this case, which
    is the moment to read the three behavioural cases above and update it deliberately.
    */
    const source = readFileSync(join(__dirname, "..", "runtimes", "in-process-runtime.ts"), "utf8");

    const classifierCalls = source
      .split("resolvePlanningContinuationCandidate(")
      .slice(1)
      .filter((s) => !s.startsWith("\n  item")); // the declaration's own parameter list
    const converted = classifierCalls.filter((s) => s.slice(0, s.indexOf(";")).includes("terminalColumns"));

    expect(classifierCalls.length).toBe(2);
    expect(converted.length).toBe(1);

    /* The inner predicate, called from the classifier without threading its resolved set. */
    const innerCalls = source.split("isPlanningContinuationTaskDispatchable(").slice(1)
      .filter((s) => !s.startsWith("\n  task"));
    expect(innerCalls.length).toBe(1);
    expect(innerCalls[0]?.slice(0, innerCalls[0].indexOf(")"))).not.toContain("terminal");
  });
});
