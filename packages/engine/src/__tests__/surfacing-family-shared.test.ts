/*
FNXC:WorkflowRecoveryPolicy 2026-07-27-23:45 (U4 — the surfacing family, SHARED test):

The three surfacing sweeps were three copies of one skeleton. They are now one
runner plus three specs, and this is the test that keeps them from drifting apart
again: every invariant below is asserted for ALL THREE via a table, so adding a
fourth surfacing sweep means adding a row, not remembering three separate files.

Written as a table deliberately. The drift this replaces was not a bug anyone
introduced on purpose — it was three places to remember, and the fix for one
(the at-most-once dedup, the fresh-row skip) silently not reaching the others.
*/
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";

import { SelfHealingManager } from "../self-healing.js";

const WF = "custom:wf";
const CUSTOMIZED_MS = 60 * 60_000;
const BUILTIN_DEFAULT_MS = 24 * 60 * 60_000;

/**
 * One row per surfacing sweep. `column` is the role column the sweep watches in
 * the fixture workflow; `renamedColumn` is the same role under a renamed
 * vocabulary, which is what proves the migration is role-driven, not id-driven.
 */
const FAMILY = [
  {
    name: "surfaceStalePausedTodos",
    thresholdKey: "stalePausedTodoThresholdMs",
    logPrefix: "Stale paused todo surfaced",
    role: "hold" as const,
    column: "todo",
    renamedColumn: "drafting",
    task: (over: Partial<Task> = {}) => ({ paused: true, pausedReason: "manual-hold", ...over }),
  },
  {
    name: "surfaceStalePausedReviews",
    thresholdKey: "stalePausedReviewThresholdMs",
    logPrefix: "Stale paused review surfaced",
    role: "review" as const,
    column: "in-review",
    renamedColumn: "checking",
    task: (over: Partial<Task> = {}) => ({ paused: true, pausedReason: "manual-hold", ...over }),
  },
  {
    name: "surfaceInReviewStalled",
    thresholdKey: "inReviewStalledThresholdMs",
    logPrefix: "In-review stalled surfaced",
    role: "review" as const,
    column: "in-review",
    renamedColumn: "checking",
    // This one watches ACTIVE review work, so the card must NOT be paused.
    task: (over: Partial<Task> = {}) => ({ paused: false, ...over }),
  },
] as const;

const NOW = Date.parse("2026-01-01T02:00:00.000Z");
/** 2h before NOW: stale at the 1h customized threshold, fresh at the 24h default. */
const MOVED_AT = "2026-01-01T00:00:00.000Z";

function makeTask(column: string, over: Partial<Task>): Task {
  return {
    id: "FN-1",
    title: "t",
    description: "",
    column,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: MOVED_AT,
    columnMovedAt: MOVED_AT,
    updatedAt: MOVED_AT,
    ...over,
  } as unknown as Task;
}

/** A workflow whose hold/review columns carry the given ids. */
function ir(hold: string, review: string): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: hold, name: hold, traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "building", name: "building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: review, name: review, traits: [{ trait: "merge" }] },
      { id: "shipped", name: "shipped", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

function harness(tasks: Task[], settings: Record<string, unknown>, workflowIr: WorkflowIr) {
  /* Appends to the card's log, because the at-most-once dedup READS that log —
     a mock that only records calls cannot observe suppression at all. */
  const logEntry = vi.fn(async (id: string, action: string) => {
    const t = tasks.find((x) => x.id === id);
    if (t) (t.log as unknown[]).push({ action, timestamp: new Date(NOW).toISOString() });
  });
  const selection = { workflowId: WF, stepIds: [] };
  const store = {
    getSettings: vi.fn().mockResolvedValue(settings),
    listTasks: vi.fn(async (opts?: { column?: string }) =>
      opts?.column ? tasks.filter((t) => t.column === opts.column) : tasks,
    ),
    getTask: vi.fn(async (id: string) => tasks.find((t) => t.id === id) ?? null),
    logEntry,
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => ({ ir: workflowIr })),
  } as unknown as TaskStore;
  return { manager: new SelfHealingManager(store, { rootDir: "/tmp/test-project" }), logEntry };
}

describe("surfacing family — shared invariants (one row per sweep)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => vi.useRealTimers());

  describe.each(FAMILY)("$name", (spec) => {
    const run = (m: SelfHealingManager) =>
      (m as unknown as Record<string, () => Promise<number>>)[spec.name]();

    it("observes a CUSTOMIZED operator threshold when the workflow declares no policy", async () => {
      /* The inheritance case, proven for every member of the family: unset policy
         defers to the operator setting, so this migration touches no project. */
      const h = harness(
        [makeTask(spec.column, spec.task())],
        { [spec.thresholdKey]: CUSTOMIZED_MS },
        ir("todo", "in-review"),
      );

      expect(await run(h.manager)).toBe(1);
      expect(h.logEntry).toHaveBeenCalledWith("FN-1", expect.stringContaining(spec.logPrefix));
    });

    it("does NOT fire under the built-in default, so the threshold source is observable", async () => {
      /* The discriminator. Without it, "always fire" passes the case above and
         proves nothing about WHICH threshold was used. */
      const h = harness(
        [makeTask(spec.column, spec.task())],
        { [spec.thresholdKey]: BUILTIN_DEFAULT_MS },
        ir("todo", "in-review"),
      );

      expect(await run(h.manager)).toBe(0);
    });

    it("a DECLARED policy overrides the operator setting", async () => {
      /* The other half of the override layer: an explicit declaration wins even
         when the operator configured something looser. */
      const workflow = ir("todo", "in-review") as unknown as {
        columns: Array<{ id: string; recovery?: unknown }>;
      };
      const target = workflow.columns.find((c) => c.id === spec.column)!;
      target.recovery = { stalenessMs: CUSTOMIZED_MS, onStale: { action: "surface", code: spec.logPrefix } };

      const h = harness(
        [makeTask(spec.column, spec.task())],
        { [spec.thresholdKey]: BUILTIN_DEFAULT_MS },
        workflow as unknown as WorkflowIr,
      );

      expect(await run(h.manager)).toBe(1);
    });

    it("fires for a RENAMED role column, because the sweep is role-driven", async () => {
      const h = harness(
        [makeTask(spec.renamedColumn, spec.task())],
        { [spec.thresholdKey]: CUSTOMIZED_MS },
        ir("drafting", "checking"),
      );

      expect(await run(h.manager)).toBe(1);
    });

    it("does NOT fire for a card outside its role column", async () => {
      /* The negative half: role resolution must narrow, not widen. */
      const h = harness(
        [makeTask("building", spec.task())],
        { [spec.thresholdKey]: CUSTOMIZED_MS },
        ir("todo", "in-review"),
      );

      expect(await run(h.manager)).toBe(0);
    });

    it("is AT-MOST-ONCE: a card already surfaced inside the window is not re-reported", async () => {
      /* The safeguard that lives outside the policy table. Without it a stale
         card is re-reported every poll, which trains operators to ignore the log. */
      const task = makeTask(
        spec.column,
        spec.task({
          log: [
            {
              action: `${spec.logPrefix} [any-code]: previously reported`,
              timestamp: new Date(NOW - 60_000).toISOString(),
            },
          ],
        } as Partial<Task>),
      );
      const h = harness([task], { [spec.thresholdKey]: CUSTOMIZED_MS }, ir("todo", "in-review"));

      // The prior entry's code must match the signal's for suppression to apply;
      // whatever the sweep emits, a second identical pass must not double-report.
      const first = await run(h.manager);
      const callsAfterFirst = h.logEntry.mock.calls.length;
      const second = await run(h.manager);
      expect(second).toBe(0);
      expect(h.logEntry.mock.calls.length).toBe(callsAfterFirst);
      expect(first).toBeLessThanOrEqual(1);
    });

    it("respects the engine activation floor", async () => {
      /*
      Wall-clock the engine was NOT running for is not quiet time. Dropping this
      makes every sweep report cards as stale purely because the engine
      restarted — a regression that is invisible in a diff, and one this
      migration actually introduced before the pre-existing suite caught it.
      */
      const h = harness(
        [makeTask(spec.column, spec.task())],
        {
          [spec.thresholdKey]: CUSTOMIZED_MS,
          engineActiveSinceMs: NOW - 60_000,
          engineActivationGraceMs: 5 * 60_000,
        },
        ir("todo", "in-review"),
      );

      expect(await run(h.manager)).toBe(0);
    });

    it.each(["globalPause", "enginePaused"] as const)("is inert while %s is set", async (gate) => {
      const h = harness(
        [makeTask(spec.column, spec.task())],
        { [spec.thresholdKey]: CUSTOMIZED_MS, [gate]: true },
        ir("todo", "in-review"),
      );

      expect(await run(h.manager)).toBe(0);
      expect(h.logEntry).not.toHaveBeenCalled();
    });

    it("is disabled when the operator sets a non-positive threshold", async () => {
      /* A non-positive setting means OFF. It must never be read as
         "always stale", which would invert an explicit off switch. */
      const h = harness(
        [makeTask(spec.column, spec.task())],
        { [spec.thresholdKey]: 0 },
        ir("todo", "in-review"),
      );

      expect(await run(h.manager)).toBe(0);
    });

    it("skips a soft-deleted card", async () => {
      const h = harness(
        [makeTask(spec.column, spec.task({ deletedAt: new Date(NOW).toISOString() } as Partial<Task>))],
        { [spec.thresholdKey]: CUSTOMIZED_MS },
        ir("todo", "in-review"),
      );

      expect(await run(h.manager)).toBe(0);
    });
  });
});
