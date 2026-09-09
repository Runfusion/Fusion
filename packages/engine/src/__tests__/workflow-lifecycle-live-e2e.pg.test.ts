/*
FNXC:WorkflowLifecycleColumns 2026-07-27-14:10 (E2E validation — workflow-owned lifecycle):

WHY THIS FILE EXISTS. Every slice of the column-vocabulary program so far has closed with the
same caveat: "no renamed workflow was run against a live engine; all evidence is unit-level."
That caveat is load-bearing — eight times this program a test passed without exercising its
subject (a mock that ignored the column filter it was asserting, a fixture that silently
resolved to the default IR, a spy that passed on an event the bus refused). This file removes
the caveat for the lifecycle spine by driving the REAL pieces:

  - a REAL PostgreSQL TaskStore (per-file throwaway database, never the operator's),
  - the REAL graph interpreter (`WorkflowGraphTaskRunner`) with the REAL column-boundary
    controller wired to the REAL `store.moveTask` — all of its guards, traits, capacity
    reservation, and post-commit event emission,
  - the REAL scheduler release path (`runHoldReleaseSweep`),
  - the REAL post-commit lifecycle bus (`getWorkflowEventBus`).

Only two things are substituted, and both are the AI itself: the workflow SEAMS (planning /
execute / review — the lanes that would otherwise call a provider) and the clock. That is the
same boundary `testMode`/`mock` draws in production, not a convenience.

ASSERTION RULE. Every lifecycle claim is asserted on OBSERVED PERSISTED STATE — a fresh
`getTask` after clearing the store's task cache, a `run_audit_events` row read back through the
admin connection, a `workflow_work_items` row — never on "a function was called". Where a spy IS
used (the event-bus subscriber) the assertion is on the RECEIVED payload, because the bus
silently drops events that fail its shape check, so "emit was called" proves nothing.

DIFFERENTIAL DESIGN. The default-vocabulary and renamed-vocabulary workflows are generated from
ONE builder (`lifecycleIr`) and differ ONLY in their four column ids. Any behavioral difference
between the two runs is therefore attributable to the vocabulary and nothing else — which is the
single claim the whole conversion program rests on.

LANE. `.pg.test.ts` under the engine-default include glob, skipped via `pgDescribe` when no
PostgreSQL is reachable, so the merge gate is unaffected. Uses the shared PG harness's
throwaway per-file database; never port 4040; no temp-root walk.
*/
import { beforeAll, beforeEach, afterEach, afterAll, expect, it, describe } from "vitest";
import "@fusion/core"; // registers the built-in column traits into the shared registry
import type { Settings, Task, TaskDetail, TaskStore, WorkflowIr } from "@fusion/core";
import {
  getWorkflowEventBus,
  resetWorkflowEventBusForTesting,
  type WorkflowLifecycleEvent,
} from "@fusion/core";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";

import { WorkflowGraphTaskRunner, type WorkflowColumnBoundaryHooks } from "../workflows/workflow-graph-task-runner.js";
import { createExecutorColumnBoundaryHooks } from "../workflow-column-boundary-hooks.js";
import { runHoldReleaseSweep } from "../execution/hold-release.js";
import { DEFAULT_VOCAB, RENAMED_VOCAB, MERGED_VOCAB, MERGED_RENAMED_VOCAB, HOLD_STALENESS_MS, lifecycleIr, type Vocabulary } from "./_workflow-vocabulary-fixture.js";
import { seedPlannedSpec } from "./_planned-spec-fixture.js";
import { SelfHealingManager } from "../self-healing.js";
import { reconcileRecovery } from "../recovery-reconciler.js";

const OK = { outcome: "success" as const };

/** Records which seams actually ran, so "exactly once" is asserted on real invocations. */
interface SeamLog {
  readonly calls: string[];
}

/* The `merge` entry is not decoration: `MERGE_REGION_KINDS` in workflow-graph-executor collapses
   ANY entry into the merge region (merge-gate included) onto the legacy `merge` seam, so the walk
   below genuinely reaches the merge lane before the terminal column. Scripting it is the same
   substitution `testMode` makes; the column move that follows is real. */
/*
FNXC:ReviewRework 2026-07-30-01:20 (U9 E2E evidence — the review half):
Seams whose REVIEW fails its first call and succeeds afterwards, so the graph takes
the `review --failure--> exec` rework edge exactly once. `OK` everywhere else, so the
only behavioural difference from `scriptedSeams` is the verdict.
*/
function revisingSeams(log: SeamLog) {
  const base = scriptedSeams(log);
  let reviewCalls = 0;
  return {
    ...base,
    review: async () => {
      log.calls.push("review");
      reviewCalls += 1;
      return reviewCalls === 1 ? { outcome: "failure" as const, value: "REVISE" } : OK;
    },
  };
}

function scriptedSeams(log: SeamLog) {
  const seam = (name: string) => async () => {
    log.calls.push(name);
    return OK;
  };
  return {
    planning: seam("planning"),
    execute: seam("execute"),
    review: seam("review"),
    merge: seam("merge"),
    schedule: seam("schedule"),
  };
}

pgDescribe("live lifecycle E2E: real graph + real PostgreSQL store", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_lifecycle_live_e2e",
    projectId: "project-workflow-lifecycle-live-e2e",
  });

  beforeAll(h.beforeAll);
  beforeEach(async () => {
    await h.beforeEach();
    resetWorkflowEventBusForTesting();
  });
  afterEach(async () => {
    resetWorkflowEventBusForTesting();
    await h.afterEach();
  });
  afterAll(h.afterAll);

  /** Persist a real custom workflow definition and return the id the STORE assigned.
   *  `createWorkflowDefinition` allocates its own `WF-###` and IGNORES the `id` in the input —
   *  binding a task to the id we passed in silently resolves to the DEFAULT builtin IR, which is
   *  exactly how a renamed-workflow fixture can pass while testing nothing. */
  async function seedWorkflow(v: Vocabulary, key: string, merged = false, reviewRework = false): Promise<{ workflowId: string; ir: WorkflowIr }> {
    const ir = lifecycleIr(v, `custom:${key}`, { mergedIntakeAndHold: merged, reviewRework });
    const created = await h.store().createWorkflowDefinition({
      name: `Lifecycle ${key}`,
      kind: "workflow",
      ir,
    } as never);
    return { workflowId: (created as { id: string }).id, ir };
  }

  /** Create a real task resting in the workflow's hold column, bound to that workflow. */
  async function seedTask(taskId: string, v: Vocabulary, workflowId: string): Promise<Task> {
    const store = h.store();
    const task = await store.createTaskWithReservedId(
      { description: `live e2e ${taskId}`, column: v.hold } as never,
      { taskId, applyDefaultWorkflowSteps: false } as never,
    );
    await store.writeTaskWorkflowSelection(taskId, workflowId, []);
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-30-12:05 (release-leg fixture):
    The card needs a spec FN-7648 accepts as PLANNED before the sweep will release it. The
    reasoning, the two dead-end hypotheses, and the self-check now live in
    `_planned-spec-fixture.ts` — this defect was diagnosed three times independently because it
    presents as a scheduler bug, so it is documented once at the seam that causes it.
    */
    seedPlannedSpec(store, taskId);
    return task as Task;
  }

  /** The persisted column, read back from PostgreSQL with the store's task cache defeated so the
   *  value can only have come from the row. */
  async function persistedColumn(taskId: string): Promise<string> {
    const store = h.store();
    store.taskCache.delete(taskId);
    const row = await store.getTask(taskId);
    return row.column as string;
  }

  /** Column-transition audit rows as the engine actually wrote them, read back from PostgreSQL. */
  async function columnTransitionAudit(taskId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await h.store().getRunAuditEventsAsync({ taskId });
    return rows
      .filter((r) => r.mutationType === "task:column-transition")
      .map((r) => (typeof r.metadata === "string" ? JSON.parse(r.metadata) : r.metadata) as Record<string, unknown>);
  }

  /*
  FNXC:WorkflowColumnBoundary 2026-07-27-16:40 (PR #2475 review, P2):
  The PRODUCTION wiring, not a copy of it. An earlier revision of this file rebuilt the hooks by
  hand and the copy had ALREADY diverged from `Executor.buildColumnBoundaryHooks` in three places
  (see the PR thread): a broader active-continuation filter, a missing graph-owned-move marker, and
  a different audit run id. A test that rebuilds the wiring proves the copy works. The factory was
  therefore lifted out of the Executor's private method into
  `createExecutorColumnBoundaryHooks`, which BOTH the Executor and this file now call — so a future
  divergence is impossible by construction rather than by review vigilance.

  `markMoveInFlight`/`clearMoveInFlight` are genuine Executor state (`workflowLifecycleMovesInFlight`,
  read together with `graphRouting` in the executor's requeue path). There is no Executor here, so
  they are recorded instead of dropped — that keeps the call observable rather than silently absent.
  */
  function boundaryHooks(taskId: string, runId: string, moveMarks: string[]): WorkflowColumnBoundaryHooks {
    const store = h.store();
    return createExecutorColumnBoundaryHooks({
      store,
      task: { id: taskId },
      workflowRunId: runId,
      markMoveInFlight: (id) => moveMarks.push(`+${id}`),
      clearMoveInFlight: (id) => moveMarks.push(`-${id}`),
    });
  }

  function makeRunner(
    taskId: string,
    workflowId: string,
    log: SeamLog,
    moveMarks: string[] = [],
    seamsFactory?: (l: SeamLog) => unknown,
  ) {
    const store = h.store();
    const runId = `${taskId}:workflow`;
    return new WorkflowGraphTaskRunner({
      store: {
        getTaskWorkflowSelection: () => ({ workflowId, stepIds: [] }),
        getTaskWorkflowSelectionAsync: async () => ({ workflowId, stepIds: [] }),
        getWorkflowDefinition: async (id: string) => store.getWorkflowDefinition(id),
        getTask: (id: string) => store.getTask(id),
      },
      runId,
      seams: (seamsFactory ?? scriptedSeams)(log) as never,
      runCustomNode: async () => {
        throw new Error("no custom node should run in this lifecycle shape");
      },
      columnBoundaryHooks: boundaryHooks(taskId, runId, moveMarks),
    } as never);
  }

  const settings = { experimentalFeatures: { workflowGraphExecutor: true } } as unknown as Settings;

  async function detail(taskId: string): Promise<TaskDetail> {
    h.store().taskCache.delete(taskId);
    return (await h.store().getTask(taskId)) as TaskDetail;
  }

  /**
   * The full lifecycle, driven for one vocabulary. Returns everything observed so the two
   * vocabularies can be compared field-for-field rather than eyeballed.
   */
  async function driveLifecycle(taskId: string, v: Vocabulary, key: string, merged = false) {
    const { workflowId } = await seedWorkflow(v, key, merged);
    await seedTask(taskId, v, workflowId);

    const events: WorkflowLifecycleEvent[] = [];
    const bus = getWorkflowEventBus();
    bus.subscribe((e) => {
      events.push(e);
    }, { name: "e2e-observer" });

    const log: SeamLog = { calls: [] };
    const moveMarks: string[] = [];
    const columnsObserved: Record<string, string> = {};

    columnsObserved.atCreate = await persistedColumn(taskId);

    // ── Leg 1: graph run from the hold column. The planning seam runs in place; the card must
    //    PARK at the hold→wip boundary because the scheduler — not the graph — owns that move.
    const leg1 = await makeRunner(taskId, workflowId, log, moveMarks).run(await detail(taskId), settings);
    columnsObserved.afterPlanning = await persistedColumn(taskId);

    // ── Leg 2: the REAL scheduler release sweep grants capacity and issues the hold→wip move.
    const sweep = await runHoldReleaseSweep(h.store(), { now: () => Date.now() });
    columnsObserved.afterRelease = await persistedColumn(taskId);

    // ── Leg 3: resume the graph at the recorded continuation node and run to the terminal.
    const items = await h.store().listWorkflowWorkItemsForTask(taskId, { kinds: ["task"] });
    const resumeNode = items.find((i) => i.state === "held" || i.state === "runnable" || i.state === "running")?.nodeId;
    const leg3 = await makeRunner(taskId, workflowId, log, moveMarks).run(await detail(taskId), settings, resumeNode);
    columnsObserved.afterRun = await persistedColumn(taskId);

    await bus.drain();

    return {
      workflowId,
      leg1,
      leg3,
      sweep,
      resumeNode,
      columnsObserved,
      moveMarks,
      seamCalls: log.calls,
      events,
      audit: await columnTransitionAudit(taskId),
    };
  }

  describe("scenario 1 — DEFAULT vocabulary (the legacy column ids)", () => {
    it("persists the card in the expected column at every stage of a real graph run", async () => {
      const r = await driveLifecycle("FN-E2E-1", DEFAULT_VOCAB, "default-vocab");

      expect(r.columnsObserved.atCreate).toBe(DEFAULT_VOCAB.hold);
      // Planning ran in the hold column; the graph parked rather than self-promoting to WIP.
      expect(r.columnsObserved.afterPlanning).toBe(DEFAULT_VOCAB.hold);
      expect(r.seamCalls).toContain("planning");
      // The scheduler — not the graph — performed the hold→wip move.
      expect(r.sweep.released).toContain("FN-E2E-1");
      expect(r.columnsObserved.afterRelease).toBe(DEFAULT_VOCAB.wip);
      // The resumed run walked exec → review → end and landed in the terminal column.
      expect(r.columnsObserved.afterRun).toBe(DEFAULT_VOCAB.complete);
      expect(r.seamCalls).toEqual(["planning", "execute", "review", "merge"]);
      expect(r.leg3.disposition).toBe("completed");
      /* The graph-owned-move marker the Executor uses to tell "the graph moved this card" from
         "someone else moved it". Two graph-owned crossings (→review, →complete), each marked and
         cleared in a balanced pair. */
      expect(r.moveMarks).toEqual(["+FN-E2E-1", "-FN-E2E-1", "+FN-E2E-1", "-FN-E2E-1"]);
    });
  });

  describe("scenario 2 — RENAMED vocabulary (the case the conversion exists for)", () => {
    it("persists the card in the expected RENAMED column at every stage of a real graph run", async () => {
      const r = await driveLifecycle("FN-E2E-2", RENAMED_VOCAB, "renamed-vocab");

      expect(r.columnsObserved.atCreate).toBe(RENAMED_VOCAB.hold);
      expect(r.columnsObserved.afterPlanning).toBe(RENAMED_VOCAB.hold);
      expect(r.seamCalls).toContain("planning");
      expect(r.sweep.released).toContain("FN-E2E-2");
      expect(r.columnsObserved.afterRelease).toBe(RENAMED_VOCAB.wip);
      expect(r.columnsObserved.afterRun).toBe(RENAMED_VOCAB.complete);
      expect(r.seamCalls).toEqual(["planning", "execute", "review", "merge"]);
      expect(r.leg3.disposition).toBe("completed");
      // No leg of this run may touch a legacy column id.
      const legacy = new Set(Object.values(DEFAULT_VOCAB));
      for (const col of Object.values(r.columnsObserved)) {
        expect(legacy.has(col)).toBe(false);
      }
      // The renamed run marks its graph-owned moves exactly as the default one does.
      expect(r.moveMarks).toEqual(["+FN-E2E-2", "-FN-E2E-2", "+FN-E2E-2", "-FN-E2E-2"]);
    });

    it("writes the same column-transition audit trail as the default vocabulary", async () => {
      const def = await driveLifecycle("FN-E2E-3", DEFAULT_VOCAB, "audit-default");
      const ren = await driveLifecycle("FN-E2E-4", RENAMED_VOCAB, "audit-renamed");

      /* The differential: the graph-owned boundary crossings must be the SAME crossings, node for
         node, in the same order — only the column vocabulary differs. A guard keyed on a legacy
         literal shows up here as a missing row on the renamed side. */
      const shape = (rows: Array<Record<string, unknown>>) =>
        rows.map((m) => ({ nodeId: m.nodeId })).sort((a, b) => String(a.nodeId).localeCompare(String(b.nodeId)));

      expect(shape(ren.audit)).toEqual(shape(def.audit));
      expect(ren.audit.length).toBeGreaterThan(0);

      const renamedColumns = new Set(ren.audit.flatMap((m) => [m.fromColumn, m.toColumn]).filter(Boolean));
      for (const legacyId of Object.values(DEFAULT_VOCAB)) {
        expect(renamedColumns.has(legacyId)).toBe(false);
      }
    });
  });

  /*
  FNXC:MergedPlanningColumn 2026-07-30-00:20 (U9 E2E evidence — the merged board):
  Scenarios 1 and 2 both drive a board where intake and hold are SEPARATE columns.
  The operator's real default workflow no longer looks like that: U11 merged them into
  one Planning column. The release path is where that matters — `runHoldReleaseSweep`
  has to release a card FROM a column that is simultaneously the intake column, and a
  resolver that treats "intake" and "hold" as mutually exclusive roles would leave the
  card parked forever with no error.

  Two variants: MERGED_VOCAB keeps legacy ids so a failure is attributable to the ROLE
  merge alone, and MERGED_RENAMED_VOCAB moves ids too, which is what a custom workflow
  author actually produces.
  */
  describe("scenario 3 — MERGED intake+hold column (U11's shape)", () => {
    it("releases and completes a card whose hold column is ALSO the intake column", async () => {
      const r = await driveLifecycle("FN-E2E-MERGED", MERGED_VOCAB, "merged-vocab", true);

      expect(r.columnsObserved.atCreate).toBe(MERGED_VOCAB.hold);
      // Planning runs IN PLACE on the merged column — it must not be treated as a
      // pre-intake staging lane the card has to leave first.
      expect(r.columnsObserved.afterPlanning).toBe(MERGED_VOCAB.hold);
      // The claim this scenario exists for: capacity release works from a dual-role column.
      expect(r.sweep.released).toContain("FN-E2E-MERGED");
      expect(r.columnsObserved.afterRelease).toBe(MERGED_VOCAB.wip);
      expect(r.columnsObserved.afterRun).toBe(MERGED_VOCAB.complete);
      expect(r.seamCalls).toEqual(["planning", "execute", "review", "merge"]);
    });

    it("does the same on a board that is BOTH merged and renamed", async () => {
      const r = await driveLifecycle("FN-E2E-MR", MERGED_RENAMED_VOCAB, "merged-renamed", true);

      expect(r.columnsObserved.atCreate).toBe(MERGED_RENAMED_VOCAB.hold);
      expect(r.sweep.released).toContain("FN-E2E-MR");
      expect(r.columnsObserved.afterRelease).toBe(MERGED_RENAMED_VOCAB.wip);
      expect(r.columnsObserved.afterRun).toBe(MERGED_RENAMED_VOCAB.complete);
      // No leg may touch a legacy id on this board.
      const legacy = new Set(["triage", "todo", "in-progress", "in-review", "done"]);
      for (const observed of Object.values(r.columnsObserved)) expect(legacy.has(observed)).toBe(false);
    });
  });

  describe("scenario 4 — the post-commit event seam under a real move", () => {
    it("delivers a well-formed TaskTransitioned to a real subscriber for a RENAMED move", async () => {
      const r = await driveLifecycle("FN-E2E-5", RENAMED_VOCAB, "events-renamed");

      const transitions = r.events.filter((e) => e.type === "TaskTransitioned");
      /* Asserted on the RECEIVED payload, never on "emit was called": the bus drops events that
         fail its shape check silently, so a spy on emit passes on a refused event. */
      expect(transitions.length).toBeGreaterThan(0);
      const released = transitions.find(
        (e) => (e as { from?: string }).from === RENAMED_VOCAB.hold && (e as { to?: string }).to === RENAMED_VOCAB.wip,
      );
      expect(released).toBeDefined();
      expect(released).toMatchObject({ taskId: "FN-E2E-5" });
      expect(typeof (released as { at?: unknown }).at).toBe("string");

      const terminal = transitions.find((e) => (e as { to?: string }).to === RENAMED_VOCAB.complete);
      expect(terminal).toBeDefined();
    });

    it("delivers NodeEntered for every traversed node, including the columnless-move cases", async () => {
      const r = await driveLifecycle("FN-E2E-6", RENAMED_VOCAB, "nodes-renamed");

      const entered = r.events.filter((e) => e.type === "NodeEntered").map((e) => (e as { nodeId: string }).nodeId);
      // Entry is announced for EVERY node the walk touches — same-column chains and the terminal
      // `end` included — which is what makes it usable as a graph-progress signal.
      expect(entered).toContain("plan");
      expect(entered).toContain("exec");
      expect(entered).toContain("review");
      expect(entered).toContain("end");
    });
  });

  describe("scenario 5 — crash / restart", () => {
    it("resumes exactly once at the recorded node and does not re-run a completed seam", async () => {
      const v = RENAMED_VOCAB;
      const { workflowId } = await seedWorkflow(v, "crash-renamed");
      await seedTask("FN-E2E-7", v, workflowId);

      const log: SeamLog = { calls: [] };

      // Leg 1 — the run parks at the capacity boundary, writing a durable continuation row. This
      // is the crash point: everything after it is a fresh process's view of persisted state.
      await makeRunner("FN-E2E-7", workflowId, log).run(await detail("FN-E2E-7"), settings);
      expect(log.calls).toEqual(["planning"]);

      const items = await h.store().listWorkflowWorkItemsForTask("FN-E2E-7", { kinds: ["task"] });
      const held = items.filter((i) => i.state === "held");
      // Exactly one continuation — a second row would mean a restart double-dispatches.
      expect(held).toHaveLength(1);
      expect(held[0].nodeId).toBe("exec");
      expect(held[0].targetColumn).toBe(v.wip);
      expect(held[0].sourceColumn).toBe(v.hold);

      await runHoldReleaseSweep(h.store(), { now: () => Date.now() });

      // "Restart": build a brand-new runner (no in-memory state carried over) and resume from the
      // node the ROW recorded, not from anything the previous runner remembered.
      const resumed = await makeRunner("FN-E2E-7", workflowId, log).run(
        await detail("FN-E2E-7"),
        settings,
        held[0].nodeId,
      );

      expect(resumed.disposition).toBe("completed");
      // Exactly-once: planning ran in leg 1 and must NOT run again on resume.
      expect(log.calls).toEqual(["planning", "execute", "review", "merge"]);
      expect(await persistedColumn("FN-E2E-7")).toBe(v.complete);

      // And the durable continuation must not have been duplicated by the resume.
      const after = await h.store().listWorkflowWorkItemsForTask("FN-E2E-7", { kinds: ["task"] });
      expect(after.filter((i) => i.nodeId === "exec")).toHaveLength(1);
    });
  });

  /*
  FNXC:WorkflowLifecycleColumns 2026-07-27-18:30 (converted-sweep table):

  A TABLE, not a scenario per sweep. The U4 conversion keeps ADDING callers of the lifecycle-role
  resolution — the count went from one to two while PR #2475 was in review — so a suite with a
  bespoke `describe` per sweep is a coverage claim that quietly goes stale. Adding a converted
  sweep here is one entry.

  Each entry declares four things and the shared driver derives four assertions from them:

    seed   — put a card in a given column in whatever state the sweep keys on
    run    — invoke the REAL sweep on a REAL store
    acted  — did the sweep act on this card? READ FROM THE PERSISTED ROW, never from a callback
    roles  — the lifecycle ROLE it must act on, and one it must stay inert in

  Derived per entry: {default vocabulary, renamed vocabulary} x {positive, negative}. The default
  half is the regression floor; the renamed half is the claim the conversion exists for; the
  negative half is what stops "resolve the column per task" from degrading into "act on everything".

  DELIBERATELY ROLE-TYPED. `actsOnRole`/`inertRole` are keys of `Vocabulary`, not column strings, so
  an entry cannot accidentally hardcode `todo` and pass for the wrong reason.

  IF A SWEEP DOES NOT FIT. Report it rather than hand-rolling a one-off beside the table — a sweep
  whose outcome cannot be observed on the persisted row is itself a finding about that sweep. See
  the UNPROVEN SITES ledger at the foot of this file for what is not covered and why.
  */
  interface SweepCaseContext {
    readonly store: TaskStore;
    readonly taskId: string;
    readonly vocab: Vocabulary;
    readonly column: string;
    readonly workflowId: string;
  }

  interface ConvertedSweepCase {
    /** The sweep method under test. */
    readonly sweep: string;
    /** Where the converted lifecycle-role resolution lives, for the ledger. */
    readonly site: string;
    /** Put a card in `ctx.column` in whatever state this sweep keys on. */
    readonly seed: (ctx: SweepCaseContext) => Promise<void>;
    /** Project settings this sweep needs in order to run at all. */
    readonly settings?: Record<string, unknown>;
    /** Invoke the REAL sweep. Returns whatever it produces, for decision-only entries. */
    readonly run: (store: TaskStore, vocab: Vocabulary) => Promise<unknown>;
    /*
    WHERE THE OUTCOME IS OBSERVED. `persisted-row` is the strong form and the default expectation:
    the sweep changed the row, and `acted` reads it back through `getTask`. `returned-decision` is
    WEAKER EVIDENCE and is recorded as such — the sweep produces a decision it does not apply, so
    there is no row to read. An entry must not silently use the weak form: naming it here is what
    keeps the ledger at the foot of this file truthful about what "covered" means per site.
    */
    readonly observability: "persisted-row" | "returned-decision";
    /** Did the sweep act? For `persisted-row` entries, read the row and ignore `runResult`. */
    readonly acted: (task: TaskDetail, vocab: Vocabulary, runResult: unknown) => boolean;
    /** The lifecycle role the sweep must act on. */
    readonly actsOnRole: keyof Vocabulary;
    /** A role of the SAME workflow the sweep must leave alone. */
    readonly inertRole: keyof Vocabulary;
  }

  /** Promote through the store's real transition policy: hold → wip → review.
   *  A DIRECT hold → review move is refused ("Invalid transition: 'backlog' → 'checking'. Valid
   *  targets: building") and that refusal is itself workflow-resolved — the renamed board's only
   *  legal target is its own `building` — so it is honored rather than bypassed. */
  async function promoteThroughPolicy(store: TaskStore, taskId: string, v: Vocabulary): Promise<boolean> {
    for (const target of [v.wip, v.review]) {
      await store.moveTask(taskId, target, {
        moveSource: "engine",
        bypassGuards: true,
        preserveProgress: true,
        allowDirectInReviewMove: true,
        skipMergeBlocker: true,
      } as never);
    }
    return true;
  }

  const STALE_PAUSED_THRESHOLD_MS = 24 * 60 * 60_000;
  const STALE_PAUSED_MARKER = "Stale paused todo surfaced [";

  const CONVERTED_SWEEPS: ConvertedSweepCase[] = [
    {
      sweep: "recoverStrandedCompletedTodoTasks",
      observability: "persisted-row",
      site: "self-healing.ts — resolveLifecycleColumns(...).hold (slice B3.1, U4)",
      actsOnRole: "hold",
      inertRole: "wip",
      seed: async ({ store, taskId }) => {
        // Fully-complete implementation steps are this sweep's entry condition.
        await store.updateTask(taskId, { steps: [{ name: "only step", status: "done" }] } as never);
      },
      run: async (store, vocab) => {
        const manager = new SelfHealingManager(store, {
          recoverCompletedTask: async (task: Task) => promoteThroughPolicy(store, task.id, vocab),
        } as never);
        await manager.recoverStrandedCompletedTodoTasks();
      },
      // Acted iff the card actually left the hold column for the review column.
      acted: (task, vocab) => task.column === vocab.review,
    },
    {
      sweep: "surfaceStalePausedTodos",
      observability: "persisted-row",
      site: "self-healing.ts — resolveLifecycleColumns(...).hold (PR #2470 review, P1)",
      actsOnRole: "hold",
      inertRole: "wip",
      settings: { stalePausedTodoThresholdMs: STALE_PAUSED_THRESHOLD_MS },
      seed: async ({ store, taskId }) => {
        /* The store STAMPS `updatedAt`/`columnMovedAt` on every write, so `updateTask` cannot
           express an aged row at all — the patch is accepted and the value silently replaced with
           `now`, and the sweep then correctly finds nothing. Discovered by this case failing on
           BOTH vocabularies, which is what distinguishes a broken fixture from a broken guard.
           The age is therefore written through the harness's raw admin client. Seeding only: the
           assertion still reads back through the real `getTask` path. */
        await store.updateTask(taskId, { paused: true, pausedReason: "e2e-hold" } as never);
        const aged = new Date(Date.now() - STALE_PAUSED_THRESHOLD_MS * 3).toISOString();
        await h.adminSql()`
          UPDATE project.tasks
          SET column_moved_at = ${aged}, updated_at = ${aged}
          WHERE id = ${taskId}
        `;
        store.taskCache.delete(taskId);
      },
      run: async (store) => {
        await new SelfHealingManager(store, {} as never).surfaceStalePausedTodos();
      },
      /* This sweep does not move the card — it writes an operator-facing log entry. That entry IS
         persisted state (`task.log`), so it is still an observed-outcome assertion rather than a
         spy; a sweep whose only effect were in-memory would not belong in this table at all. */
      acted: (task) => (task.log ?? []).some((e) => (e.action ?? "").startsWith(STALE_PAUSED_MARKER)),
    },
    {
      /*
      Landed in #2478 AFTER the ledger below was first written — which is precisely the drift a
      table exists to absorb: covering it was one entry, not a new describe block.

      WHAT THIS ROW ACTUALLY PROVES, established by mutation rather than by reading the code. The
      census flagged `recovery-reconciler.ts:198` as a `resolveLifecycleColumns` call site, so the
      row was first labelled as covering it. It does not: destroying the role resolution in
      `resolveRoleRecovery` leaves all 18 tests GREEN, because `decideRecovery` looks the policy up
      by COLUMN ID (`resolveColumnRecovery(ir, task.column)`) and never consults a role.
      `resolveRoleRecovery` turns out to have NO production caller at all — see the ledger.

      What the row does prove, and what it is mutation-verified against: the reconciler resolves and
      matches a column-declared recovery policy on a REAL renamed board — real store, real persisted
      workflow definition, real `resolveWorkflowIrForTask`. Keying that lookup on the `todo` literal
      fails exactly this row's renamed test.

      OBSERVABILITY CAVEAT, stated rather than hidden: `reconcileRecovery` DECIDES and does not
      APPLY. The slice deliberately stops before the writer, so there is no persisted effect to read
      and `acted` must inspect the returned decision. That is weaker evidence than every other row
      here. Switch this to `persisted-row` the moment the applier lands.
      */
      sweep: "reconcileRecovery (recovery-reconciler.ts)",
      observability: "returned-decision",
      site: "recovery-reconciler.ts — resolveColumnRecovery policy lookup on a renamed board (U4, #2478)",
      actsOnRole: "hold",
      inertRole: "wip",
      seed: async ({ store, taskId }) => {
        // Rest the card in its column long enough to pass the policy's stalenessMs.
        const aged = new Date(Date.now() - HOLD_STALENESS_MS * 3).toISOString();
        await h.adminSql()`
          UPDATE project.tasks
          SET column_moved_at = ${aged}, updated_at = ${aged}
          WHERE id = ${taskId}
        `;
        store.taskCache.delete(taskId);
      },
      run: async (store) => {
        const tasks = await store.listTasks({ includeArchived: false });
        return reconcileRecovery(store, tasks, { now: () => Date.now() });
      },
      acted: (task, _vocab, runResult) =>
        (runResult as Array<{ taskId: string; code: string }>).some(
          (d) => d.taskId === task.id && d.code === "e2e-stale-hold",
        ),
    },
  ];

  describe.each(CONVERTED_SWEEPS)("converted sweep — $sweep", (testCase) => {
    /** Seed one card under `vocab` resting in `column`, then run the real sweep and report the
     *  PERSISTED outcome. */
    async function driveCase(taskId: string, vocab: Vocabulary, roleKey: keyof Vocabulary, key: string) {
      const store = h.store();
      if (testCase.settings) await store.updateSettings(testCase.settings as never);
      const { workflowId } = await seedWorkflow(vocab, key);
      const column = vocab[roleKey];
      await store.createTaskWithReservedId(
        { description: `${testCase.sweep} ${taskId}`, column } as never,
        { taskId, applyDefaultWorkflowSteps: false } as never,
      );
      await store.writeTaskWorkflowSelection(taskId, workflowId, []);
      await testCase.seed({ store, taskId, vocab, column, workflowId });
      store.taskCache.delete(taskId);

      const runResult = await testCase.run(store, vocab);

      store.taskCache.delete(taskId);
      const persisted = (await store.getTask(taskId)) as TaskDetail;
      return { persisted, acted: testCase.acted(persisted, vocab, runResult) };
    }

    it("acts on a card in the RENAMED lifecycle column", async () => {
      const r = await driveCase("FN-SW-1", RENAMED_VOCAB, testCase.actsOnRole, "sweep-renamed");
      expect(r.acted).toBe(true);
    });

    it("stays INERT for a card in a non-target column of the same renamed workflow", async () => {
      const r = await driveCase("FN-SW-2", RENAMED_VOCAB, testCase.inertRole, "sweep-renamed-neg");
      expect(r.acted).toBe(false);
      // and the card is untouched where it stands
      expect(r.persisted.column).toBe(RENAMED_VOCAB[testCase.inertRole]);
    });

    it("still acts on a DEFAULT-vocabulary card (regression floor)", async () => {
      const r = await driveCase("FN-SW-3", DEFAULT_VOCAB, testCase.actsOnRole, "sweep-default");
      expect(r.acted).toBe(true);
    });

    it("stays INERT for a default-vocabulary card in a non-target column", async () => {
      const r = await driveCase("FN-SW-4", DEFAULT_VOCAB, testCase.inertRole, "sweep-default-neg");
      expect(r.acted).toBe(false);
    });
  });
  /*
  FNXC:WorkflowCapacity 2026-07-28-19:20 (pool-id sentinel fix — E2E acceptance):

  The gate must BIND, and it must bind IN BOTH DIRECTIONS. A test that only asserts "held at cap"
  passes trivially if the mover simply never admits anything — including if a future change breaks
  admission outright — so each case is run twice against the SAME fixture with only the cap
  changed: at limit 1 the card is HELD, at limit 2 the identical card is ADMITTED.

  NO WORKFLOW SELECTION, deliberately. That is the whole defect: `moves.ts` asked the counter for
  pool `"builtin:coding"` while the counter buckets selection-less rows under
  `DEFAULT_WORKFLOW_POOL_ID`, so nothing was ever counted. A card WITH a selection makes both
  sentinels agree and the gate already bound before the fix — seeding one here would have produced a
  green test that never touched the bug. (Verified: with the fix reverted, this row fails.)

  FLAG-ON, and labelled as such. The capacity block sits inside `if (useWorkflow && …)` and
  `useWorkflow` reads a settings key nothing in production sets (Phase A3 R2, still live). So this
  row proves the SENTINEL is fixed on the only path where the gate can execute at all; it does NOT
  prove production behavior changed. Read the R2 note in workflow-capacity-invariant.pg.test.ts
  before treating this as "capacity is enforced".
  */
  describe.each([
    { limit: 1, expected: "held" as const },
    { limit: 2, expected: "admitted" as const },
  ])("in-transaction capacity gate (maxConcurrent=$limit → $expected)", ({ limit, expected }) => {
    it(`a selection-less card at the wip boundary is ${expected}`, async () => {
      const store = h.store();
      await store.updateSettings({ maxConcurrent: limit } as never);
      // The capacity block's enclosing flag is GLOBAL-scoped; a project-scoped write is silently
      // dropped and the test then measures the unflagged path while claiming otherwise.
      await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: true } } as never);

      const holder = await store.createTask({ description: "capacity holder" });
      await store.moveTask(holder.id, "todo");
      await store.moveTask(holder.id, "in-progress");

      const contender = await store.createTask({ description: "capacity contender" });
      await store.moveTask(contender.id, "todo");
      const error = await store
        .moveTask(contender.id, "in-progress")
        .then(() => null, (e: unknown) => e as Error);

      store.taskCache.delete(contender.id);
      const persisted = (await store.getTask(contender.id)).column;

      if (expected === "held") {
        expect((error as unknown as { rejection?: { code?: string } })?.rejection?.code).toBe("capacity-exhausted");
        expect(persisted).toBe("todo"); // observed state: refused, stays put
      } else {
        expect(error).toBeNull();
        expect(persisted).toBe("in-progress"); // the same fixture admits once the cap allows it
      }
    });
  });
  /*
  FNXC:LifecycleContainment 2026-09-04-18:25:
  A bare graph-review REVISE does not authorize a backward Review-to-WIP move. The graph remains in
  Review until a named remediation path publishes actionable work; this is identical on renamed
  and merged boards.
  */
  describe("scenario 6 — a bare REVISE remains contained in Review", () => {
    async function driveRevise(taskId: string, v: Vocabulary, key: string, merged: boolean) {
      const { workflowId } = await seedWorkflow(v, key, merged, true);
      await seedTask(taskId, v, workflowId);
      const log: SeamLog = { calls: [] };
      const marks: string[] = [];

      // Leg 1: plan in the hold column, park at the capacity boundary.
      await makeRunner(taskId, workflowId, log, marks, revisingSeams).run(await detail(taskId), settings);
      // Leg 2: the real sweep releases into wip.
      await runHoldReleaseSweep(h.store(), { now: () => Date.now() });
      const afterRelease = await persistedColumn(taskId);
      // Leg 3: execute -> review -> REVISE, then contain the failure in Review.
      const items = await h.store().listWorkflowWorkItemsForTask(taskId, { kinds: ["task"] });
      const resumeNode = items.find((i) => ["held", "runnable", "running"].includes(i.state))?.nodeId;
      const leg3 = await makeRunner(taskId, workflowId, log, marks, revisingSeams)
        .run(await detail(taskId), settings, resumeNode);
      return { afterRelease, afterRevise: await persistedColumn(taskId), calls: log.calls, leg3 };
    }

    it("keeps a renamed-board REVISE in Review without redispatching execution", async () => {
      const r = await driveRevise("FN-E2E-REV", RENAMED_VOCAB, "revise-renamed", false);

      expect(r.afterRelease).toBe(RENAMED_VOCAB.wip);
      expect(r.calls).toEqual(["planning", "execute", "review"]);
      expect(r.afterRevise).toBe(RENAMED_VOCAB.review);
    });

    it("does the same on a merged board without bouncing to its dual-role planning column", async () => {
      const r = await driveRevise("FN-E2E-REV-M", MERGED_VOCAB, "revise-merged", true);

      expect(r.afterRelease).toBe(MERGED_VOCAB.wip);
      expect(r.calls).toEqual(["planning", "execute", "review"]);
      expect(r.afterRevise).toBe(MERGED_VOCAB.review);
    });
  });

});

/*
FNXC:WorkflowLifecycleColumns 2026-07-28-16:10 — UNPROVEN SITES LEDGER.

Kept deliberately, and kept HONEST: the difference between "the E2E covers the conversion" and
"the E2E covers N of M sites" is this list. Census re-taken against main at b133d521c4 (it had
already drifted once — #2478 landed a new site between the first census and this one, which is why
the coverage above is a table).

Census method: every caller of `resolveLifecycleColumns`, `resolveCompleteColumn`,
`resolveMergeOrchestrationColumn`, `resolveReboundTarget`, `resolveTaskLifecycleColumns`,
`columnHasFlag`, `columnsWithFlag` outside tests and the barrel re-exports.

PROVEN end to end against a live renamed workflow by this file (each mutation-verified, and for the
two self-healing sweeps verified PER SITE — reverting one fails exactly its own row):
  - self-healing.ts        recoverStrandedCompletedTodoTasks   (table row, persisted-row)
  - self-healing.ts        surfaceStalePausedTodos             (table row, persisted-row)
  - recovery-reconciler.ts column-declared policy lookup       (table row, returned-decision — WEAKER)
  - hold-release.ts        isHeldTask / the capacity release   (spine)
  - the graph column boundary + store.moveTask + the post-commit bus (spine)
  - self-healing.ts  resolveReboundTarget, BOTH paths — the undeclared-column repair
    (reconcileUndeclaredTaskColumns) and the session-start requeue
    (autoRecoverWorktreeSessionStartFailure); workflow-rebound-family-live-e2e.pg.test.ts,
    each mutation-verified independently
  - task-agent-sync.ts  resolveTaskLifecycleColumns — agent-link hygiene on a real
    TaskStore + real AgentStore + the real `task:moved` subscription
    (workflow-agent-link-live-e2e.pg.test.ts; mutation-verified)
  - core/live-agent-count.ts  THREE of the four classifications, through the number
    admission control actually compares against the cap
    (persistedTopLevelAgentSlotsFromStore; workflow-agent-count-live-e2e.pg.test.ts):
      countsTowardWip     -> mutation fails 3 renamed cases
      terminal/complete   -> needed its OWN case; the plain complete-column test is
                             rejected at the wip check anyway and stayed green under
                             mutation. Only a complete card carrying a live-looking
                             status discriminates.
      mergeOrchestration/mergeBlocker -> needed its own case too (a review card with an
                             active merge-pipeline status)
  - mesh-lease-manager.ts  resolveReboundTarget — the recovered-lease rebound AND the
    unreachable-owner audit's `newColumn` (workflow-lease-rebound-live-e2e.pg.test.ts;
    mutation-verified). The audit half is the one that rotted silently: it named a
    column the card never reached, which on a renamed board the workflow does not even
    declare. `decisionPath` deliberately keeps its legacy wording and is pinned as such.
  - core/task-store/reads.ts  the listTasks hold-column hydration — ALREADY proven by
    core's store-stale-paused-renamed-hold.pg.test.ts, which is a real-store test that
    drives listTasks against a renamed hold column. Confirmed by mutation rather than
    by reading: forcing the hydration back to the `todo` literal fails exactly that
    file's renamed case. It was listed here as unproven because I had assumed a
    separate E2E was needed; it was not.
  - merger-ai.ts  resolveFinalizeReboundColumn — the LIVE merge path's rebound column
    (workflow-merge-rebound-live-e2e.pg.test.ts; mutation-verified). Weaker,
    returned-decision evidence: the resolver returns a column and does not move a card,
    so this proves the renamed board resolves correctly through a real store and a real
    persisted workflow, NOT that a card lands there. It was in the "needs real git"
    bucket by association; it is EXPORTED and takes (store, taskId) and touches no git.
  - auto-merge-finalization.ts  completeColumn / mergeColumn / isCompleteColumn
    (workflow-merge-family-live-e2e.pg.test.ts; each of the three mutation-verified
    INDEPENDENTLY — the mergeColumn one needed its own case, see below)

FINDING — AN UNREACHABLE EXPORT. `resolveRoleRecovery` (recovery-reconciler.ts:194) is the ONLY
use of `resolveLifecycleColumns` in that file, and it has NO production caller: `decideRecovery`
looks policy up by column id. Established by mutation — destroying the role resolution leaves all
18 tests here green, and a repo-wide grep finds no caller outside this file. So that census line is
not a live converted site; it is an exported helper written ahead of its consumer. Either its
consumer is still to land, or it should be deleted. Not resolved here: it is production code owned
by the U4 slice, and guessing which is a decision for its author.

NOT PROVEN end to end — real callers this suite does not reach:
  - merger.ts:324-326        resolveCompleteColumn / resolveMergeOrchestrationColumn /
    resolveReboundTarget — DEAD PATH, do not build a lane for these. Every call sits
    inside `aiMergeTask`, which is soft-deprecated, exported only with an @deprecated
    tag, and has NO production caller (verified by grep across all packages; the live
    merge path is merger-ai's runAiMerge / landWorkspaceTask, which project-engine
    imports). Phase B converted a path production never executes. Not deleted here —
    it is production code owned by another slice — but proving it would prove nothing.
  - merger-ai.ts:1039        isAlreadyFinalizedColumn — LIVE, but module-private and
    reached only from runAiMerge, so it does need the real-git lane
  - executor.ts:1763,6339,6341        rebound target, merge-orchestration probe, complete column

FNXC:WorkflowLifecycleColumns 2026-07-29-16:40 — TWO ENTRIES RETIRED, both wrong the same way.
Recorded rather than deleted, because the ERROR is the reusable part: each stated a LANE cost as
if it were an impossibility, and neither claim was checked against the function.

  - core/live-agent-count.ts  columnIsIntakeOrHold — NOW PROVEN, and never unreachable. The old
    entry read "the running predicate never reads it, so the admission-count E2E cannot reach it",
    which is true and irrelevant: the WAITING predicate has exactly ONE consumer,
    `deriveStatsFromTasks`, and that is an exported PURE function. The narrow seam FN-5048 asks for
    was already there. Covered by useExecutorStats.queued-column-roles.test.ts on renamed AND
    merged boards (mutation-verified: forcing the legacy id pair fails exactly those two cases),
    plus a characterization test pinning the undercount live-agent-count.ts admits in prose for a
    column absent from the flag map.

  - dashboard register-task-workflow-routes.ts — COVERED BY ITS OWNER (#2614), not by this file.
    The old reason, that standing up the route shell is the mock-the-world pattern FN-5048 forbids,
    was simply false: `createApiRoutes` + `test-request.js` is this repo's ESTABLISHED route-test
    convention, with ten existing `register-task-workflow-routes.*` suites driving a real express
    app against a stubbed store. #2614's plan-approval-intake-column.test.ts covers the merged lane,
    a renamed merged lane, and a negative case. Not duplicated here.

FOURTH and fifth wrong lane-cost inferences in this ledger (after auto-merge-finalization, both
self-healing rebounds, and resolveFinalizeReboundColumn). The rule written after the third still
stands and was still under-applied: READ WHAT THE FUNCTION TOUCHES before costing a lane for it.
"Its consumers are elsewhere" is a statement about where to put the test, not about whether one
can exist.

FNXC:WorkflowLifecycleColumns 2026-07-29-17:20 — WHY, and what each would take. Two lanes,
and neither is another table row:

  LANE 1 — REAL GIT (engine-slow), now SMALLER than it looked. Only two things
  genuinely need it: merger-ai's `isAlreadyFinalizedColumn` and executor's
  `resolveReboundColumnFor`, both module-private and reached only from inside
  merge/session machinery. merger.ts's three sites do NOT need the lane because they
  are dead (see above), and merger-ai's `resolveFinalizeReboundColumn` did not need it
  at all — it is now covered. Third time the "this family needs git" inference has
  been wrong; check what the FUNCTION touches before costing a lane for it.

  LANE 2 — DASHBOARD HTTP. register-task-workflow-routes' four sites live behind
  `registerTaskWorkflowRoutes(ctx, deps)`, which needs a full ApiRoutesContext plus
  twelve injected deps. Standing up that shell is the "mock-the-world" pattern
  FN-5048 tells us not to add, and the narrower alternative — exporting the two
  private resolvers — would yield UNIT evidence while looking like E2E. Deliberately
  not done rather than done badly and overclaimed. The same applies to
  live-agent-count's `columnIsIntakeOrHold`: it is read only by the WAITING
  predicate, whose consumers are dashboard-side.

FNXC:WorkflowLifecycleColumns 2026-07-29-17:20 — TABLE FIT. Three rows fit. The merge/rebound family does NOT — not because the table is too rigid,
but because those sweeps have no observable persisted effect without a real repository, so `acted`
cannot be written against the row at all. That is a finding about the lane they need, not a reason
to hand-roll a scenario beside the table.
*/
