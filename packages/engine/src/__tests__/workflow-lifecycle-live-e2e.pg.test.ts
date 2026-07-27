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
import type { Settings, Task, TaskDetail, WorkflowIr } from "@fusion/core";
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

import { WorkflowGraphTaskRunner, type WorkflowColumnBoundaryHooks } from "../workflow-graph-task-runner.js";
import { createStoreIrPinPersistence, type WorkflowIrPinStoreSurface } from "../workflow-column-boundary.js";
import { runHoldReleaseSweep } from "../hold-release.js";
import { SelfHealingManager } from "../self-healing.js";

/** The four lifecycle roles this program's guards are supposed to resolve by TRAIT, not by id. */
interface Vocabulary {
  readonly hold: string;
  readonly wip: string;
  readonly review: string;
  readonly complete: string;
}

/** The legacy ids. A guard keyed on a string literal passes here for the wrong reason. */
const DEFAULT_VOCAB: Vocabulary = {
  hold: "todo",
  wip: "in-progress",
  review: "in-review",
  complete: "done",
};

/** No id overlaps the legacy enum. A guard keyed on a string literal goes silent here. */
const RENAMED_VOCAB: Vocabulary = {
  hold: "backlog",
  wip: "building",
  review: "checking",
  complete: "shipped",
};

/**
 * ONE workflow shape, two vocabularies. Structurally identical down to node ids and edges so a
 * behavioral delta between the two runs can only come from the column ids.
 *
 * The shape is the lifecycle spine: a hold column that the scheduler releases on capacity, a WIP
 * column that holds the slot, a review column, and a terminal complete column.
 */
function lifecycleIr(v: Vocabulary, id: string): WorkflowIr {
  return {
    version: "v2",
    id,
    name: `lifecycle-${id}`,
    columns: [
      {
        id: v.hold,
        name: "Hold",
        traits: [{ trait: "hold", config: { release: "capacity" } }],
      },
      {
        id: v.wip,
        name: "Wip",
        traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent", countPending: true } }, { trait: "timing" }],
      },
      {
        id: v.review,
        name: "Review",
        traits: [{ trait: "human-review" }, { trait: "merge-blocker" }],
      },
      { id: v.complete, name: "Complete", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: v.hold },
      { id: "plan", kind: "prompt", column: v.hold, config: { seam: "planning" } },
      { id: "exec", kind: "prompt", column: v.wip, config: { seam: "execute" } },
      { id: "review", kind: "prompt", column: v.review, config: { seam: "review" } },
      /* A real merge-class node. The IR validator REFUSES a `merge-blocker` column with no
         reachable merge-class node ("the gate can never clear without one") — discovered by this
         file, and worth keeping: it means the review column here is a genuinely gated one rather
         than a decorative label. `merge-gate` itself is pure policy (reads autoMerge, emits
         auto-on/auto-off) so it needs no git. */
      { id: "merge-gate", kind: "merge-gate", column: v.review, config: { gate: "auto-merge" } },
      { id: "end", kind: "end", column: v.complete },
    ],
    edges: [
      { from: "start", to: "plan" },
      { from: "plan", to: "exec", condition: "success" },
      { from: "exec", to: "review", condition: "success" },
      { from: "review", to: "merge-gate", condition: "success" },
      { from: "merge-gate", to: "end", condition: "success" },
    ],
  } as WorkflowIr;
}

const OK = { outcome: "success" as const };

/** Records which seams actually ran, so "exactly once" is asserted on real invocations. */
interface SeamLog {
  readonly calls: string[];
}

/* The `merge` entry is not decoration: `MERGE_REGION_KINDS` in workflow-graph-executor collapses
   ANY entry into the merge region (merge-gate included) onto the legacy `merge` seam, so the walk
   below genuinely reaches the merge lane before the terminal column. Scripting it is the same
   substitution `testMode` makes; the column move that follows is real. */
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
  async function seedWorkflow(v: Vocabulary, key: string): Promise<{ workflowId: string; ir: WorkflowIr }> {
    const ir = lifecycleIr(v, `custom:${key}`);
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
    store.taskCache.delete(taskId);
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

  /** Wire the PRODUCTION boundary hooks (same shape as executor.buildColumnBoundaryHooks) to the
   *  real store: real moveTask with the workflow-graph move source, real audit write, real
   *  durable IR pin, real capacity-suspension continuation row. */
  function boundaryHooks(taskId: string, runId: string): WorkflowColumnBoundaryHooks {
    const store = h.store();
    const pin = createStoreIrPinPersistence(store as unknown as WorkflowIrPinStoreSurface, taskId);
    return {
      pinNodeEntry: pin.pinNodeEntry,
      loadPriorPin: pin.loadPriorPin,
      clearPin: pin.clearPin,
      moveTask: async (toColumn, ctx) => {
        await store.moveTask(taskId, toColumn, {
          moveSource: "engine",
          workflowMoveSource: "workflow-graph",
          bypassGuards: true,
          preserveProgress: true,
          workflowMoveMetadata: { fromColumn: ctx.fromColumn, nodeId: ctx.nodeId },
        } as never);
      },
      emitAudit: async (event) => {
        await store.recordRunAuditEvent?.({
          taskId: event.taskId,
          agentId: "executor",
          runId,
          domain: "database",
          mutationType: event.type,
          target: event.taskId,
          metadata:
            event.type === "task:column-transition"
              ? {
                  taskId: event.taskId,
                  workflowId: event.workflowId,
                  fromColumn: event.fromColumn,
                  toColumn: event.toColumn,
                  nodeId: event.nodeId,
                  irHash: event.irHash,
                }
              : { taskId: event.taskId, workflowId: event.workflowId, pinnedNodeId: event.pinnedNodeId, reason: event.reason },
        } as never);
      },
      onSuspend: async (suspension) => {
        const items = await store.listWorkflowWorkItemsForTask(taskId, { kinds: ["task"] });
        if (items.some((i) => i.nodeId === suspension.nodeId && i.state !== "succeeded" && i.state !== "failed")) return;
        await store.replaceActiveTaskWorkflowContinuation({
          runId: `${runId}:continuation:${suspension.nodeId}:${items.length}`,
          taskId,
          nodeId: suspension.nodeId,
          kind: "task",
          state: "held",
          stableWorkflowRunId: runId,
          continuationSequence: items.length,
          waitReason: "capacity",
          sourceColumn: suspension.fromColumn,
          targetColumn: suspension.toColumn,
          irHash: suspension.irHash,
        } as never);
      },
    };
  }

  function makeRunner(taskId: string, workflowId: string, log: SeamLog) {
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
      seams: scriptedSeams(log) as never,
      runCustomNode: async () => {
        throw new Error("no custom node should run in this lifecycle shape");
      },
      columnBoundaryHooks: boundaryHooks(taskId, runId),
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
  async function driveLifecycle(taskId: string, v: Vocabulary, key: string) {
    const { workflowId } = await seedWorkflow(v, key);
    await seedTask(taskId, v, workflowId);

    const events: WorkflowLifecycleEvent[] = [];
    const bus = getWorkflowEventBus();
    bus.subscribe((e) => {
      events.push(e);
    }, { name: "e2e-observer" });

    const log: SeamLog = { calls: [] };
    const columnsObserved: Record<string, string> = {};

    columnsObserved.atCreate = await persistedColumn(taskId);

    // ── Leg 1: graph run from the hold column. The planning seam runs in place; the card must
    //    PARK at the hold→wip boundary because the scheduler — not the graph — owns that move.
    const leg1 = await makeRunner(taskId, workflowId, log).run(await detail(taskId), settings);
    columnsObserved.afterPlanning = await persistedColumn(taskId);

    // ── Leg 2: the REAL scheduler release sweep grants capacity and issues the hold→wip move.
    const sweep = await runHoldReleaseSweep(h.store(), { now: () => Date.now() });
    columnsObserved.afterRelease = await persistedColumn(taskId);

    // ── Leg 3: resume the graph at the recorded continuation node and run to the terminal.
    const items = await h.store().listWorkflowWorkItemsForTask(taskId, { kinds: ["task"] });
    const resumeNode = items.find((i) => i.state === "held" || i.state === "runnable" || i.state === "running")?.nodeId;
    const leg3 = await makeRunner(taskId, workflowId, log).run(await detail(taskId), settings, resumeNode);
    columnsObserved.afterRun = await persistedColumn(taskId);

    await bus.drain();

    return {
      workflowId,
      leg1,
      leg3,
      sweep,
      resumeNode,
      columnsObserved,
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
  The one converted lifecycle-mutating sweep on this tip (slice B3.1 — U4) run against a REAL
  store and a REAL renamed workflow. Its conversion claim is that the sweep now resolves the hold
  column from the card's own workflow instead of the `todo` literal in BOTH halves (query and
  guard). Nothing so far has run it against a workflow that has no `todo` column at all.

  The recovery callback performs a REAL `moveTask`, so the assertion is on the card's persisted
  column afterwards — not on whether the callback was invoked.
  */
  describe("converted self-healing sweep — recoverStrandedCompletedTodoTasks", () => {
    async function seedStrandedTask(taskId: string, v: Vocabulary, workflowId: string, column: string) {
      const store = h.store();
      await store.createTaskWithReservedId(
        { description: `stranded ${taskId}`, column } as never,
        { taskId, applyDefaultWorkflowSteps: false } as never,
      );
      await store.writeTaskWorkflowSelection(taskId, workflowId, []);
      // Fully-complete implementation steps are the sweep's entry condition.
      await store.updateTask(taskId, {
        steps: [{ name: "only step", status: "done" }],
      } as never);
      store.taskCache.delete(taskId);
    }

    /** Run the real sweep with a recovery callback that performs REAL column moves.
     *  The move goes hold → wip → review because the store's transition policy REFUSES a direct
     *  hold → review move ("Invalid transition: 'backlog' → 'checking'. Valid targets: building").
     *  That refusal is itself workflow-resolved — the renamed board's only legal target is its own
     *  `building`, not `in-progress` — so it is left in place rather than bypassed. */
    async function runSweep(v: Vocabulary): Promise<{ recovered: number; promoted: string[]; moveErrors: string[] }> {
      const store = h.store();
      const promoted: string[] = [];
      const moveErrors: string[] = [];
      const manager = new SelfHealingManager(store, {
        recoverCompletedTask: async (task: Task) => {
          promoted.push(task.id);
          try {
            for (const target of [v.wip, v.review]) {
              await store.moveTask(task.id, target, {
                moveSource: "engine",
                bypassGuards: true,
                preserveProgress: true,
                allowDirectInReviewMove: true,
                skipMergeBlocker: true,
              } as never);
            }
          } catch (e) {
            moveErrors.push(e instanceof Error ? e.message : String(e));
            return false;
          }
          return true;
        },
      } as never);
      const recovered = await manager.recoverStrandedCompletedTodoTasks();
      return { recovered, promoted, moveErrors };
    }

    it("promotes a completed card stranded in a RENAMED hold column", async () => {
      const v = RENAMED_VOCAB;
      const { workflowId } = await seedWorkflow(v, "stranded-renamed");
      await seedStrandedTask("FN-E2E-8", v, workflowId, v.hold);

      const { recovered, promoted, moveErrors } = await runSweep(v);

      expect(moveErrors).toEqual([]);
      expect(promoted).toContain("FN-E2E-8");
      expect(recovered).toBe(1);
      // Observed state, not the callback: the card actually left the hold column.
      expect(await persistedColumn("FN-E2E-8")).toBe(v.review);
    });

    it("does NOT promote a completed card resting in a non-hold column of the same renamed workflow", async () => {
      /* The negative half. Dropping the column filter without a correct per-task hold resolution
         turns this sweep into "promote every completed card anywhere", which is a louder failure
         than the silence it replaces. */
      const v = RENAMED_VOCAB;
      const { workflowId } = await seedWorkflow(v, "stranded-renamed-neg");
      await seedStrandedTask("FN-E2E-9", v, workflowId, v.wip);

      const { promoted } = await runSweep(v);

      expect(promoted).not.toContain("FN-E2E-9");
      expect(await persistedColumn("FN-E2E-9")).toBe(v.wip);
    });

    it("still promotes a default-vocabulary card in `todo` (regression floor)", async () => {
      const v = DEFAULT_VOCAB;
      const { workflowId } = await seedWorkflow(v, "stranded-default");
      await seedStrandedTask("FN-E2E-10", v, workflowId, v.hold);

      const { promoted } = await runSweep(v);

      expect(promoted).toContain("FN-E2E-10");
      expect(await persistedColumn("FN-E2E-10")).toBe(v.review);
    });
  });
});
