/*
FNXC:MergedPlanningColumn 2026-07-28-09:10 (U11 precondition):

U11 merges Todo into Planning: ONE pre-implementation column that both intakes new
cards and holds them for capacity. KTD-1 asserts that shape works. Nothing in tree
has ever exercised it — every built-in splits the two roles across two columns
(`triage` intake + `todo` hold; Coding (Ideas) `ideas` intake + `todo` hold), so
"a column carrying intake AND hold" is an untested configuration, not an
established one.

These tests pin the contract BEFORE the IR changes, so the ~10-line IR edit lands
on proven substrate rather than on an assumption. They are differential: the SAME
scenario runs against the split-role vocabulary (today's shape) and the merged one
(U11's shape) and asserts the role-level outcomes match. A difference is therefore
attributable to the merge itself and to nothing else.

The failure mode being guarded is not a wrong decision but NO decision — a column
whose role a path fails to recognize makes the card invisible to that path, which
presents as a quietly stuck card rather than an error. That is how the earlier
attempt at this merge stranded cards (see
docs/solutions/architecture-patterns/workflow-node-column-placement-and-graph-entry-contract.md).

Harness deliberately mirrors `hold-release-renamed-columns.test.ts` (Phase B slice
B2) so the two differential suites stay comparable.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";
import { resolveLifecycleColumns, resolveReboundTarget, columnsWithFlag } from "@fusion/core";

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBootstrapPrompt } from "@fusion/core";

import { runHoldReleaseSweep, resetHoldReleaseInstrumentation, isUnplannedForExecution } from "../execution/hold-release.js";
import { schedulerLog } from "../logger.js";

const WF = "custom:wf";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    title: "t",
    description: "",
    column: "todo",
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    columnMovedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as Task;
}

/**
 * SPLIT — today's built-in shape: intake and hold are different columns.
 * MERGED — U11's shape: one column carries both. `planning` is deliberately NOT
 * a legacy id, so a surviving `=== "todo"` / `=== "triage"` comparison cannot
 * pass by luck.
 */
const SPLIT = { intake: "triage", hold: "todo", wip: "in-progress", complete: "done" };
const MERGED = { intake: "planning", hold: "planning", wip: "in-progress", complete: "done" };

function ir(names: { intake: string; hold: string; wip: string; complete: string }): WorkflowIr {
  const preImplementation = names.intake === names.hold
    ? [{
        id: names.hold,
        name: "Planning",
        traits: [
          { trait: "intake" },
          { trait: "hold", config: { release: "capacity" } },
          { trait: "reset-on-entry" },
        ],
      }]
    : [
        { id: names.intake, name: "Planning", traits: [{ trait: "intake" }] },
        {
          id: names.hold,
          name: "Todo",
          traits: [{ trait: "hold", config: { release: "capacity" } }, { trait: "reset-on-entry" }],
        },
      ];

  return {
    version: "v2",
    id: WF,
    nodes: [
      { id: "start", kind: "start", column: names.intake },
      { id: "planning", kind: "prompt", column: names.hold },
      { id: "execute", kind: "prompt", column: names.wip },
      { id: "end", kind: "end", column: names.complete },
    ],
    edges: [
      { from: "start", to: "planning", condition: "success" },
      { from: "planning", to: "execute", condition: "success" },
      { from: "execute", to: "end", condition: "success" },
    ],
    columns: [
      ...preImplementation,
      { id: names.wip, name: "In progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: names.complete, name: "Done", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

function storeWith(tasks: Task[], workflowIr: WorkflowIr, settings: Record<string, unknown>): TaskStore {
  const selection = { workflowId: WF, stepIds: [] };
  return {
    getSettings: vi.fn(async () => settings),
    listTasks: vi.fn(async () => tasks),
    getTask: vi.fn(async (id: string) => tasks.find((t) => t.id === id) ?? null),
    moveTaskIf: vi.fn(async (id: string, column: string) => {
      const cur = tasks.find((t) => t.id === id)!;
      cur.column = column;
      return { task: cur, moved: true };
    }),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => ({ ir: workflowIr })),
  } as unknown as TaskStore;
}

/** Run the capacity scenario and report in ROLE terms so the two shapes compare directly. */
async function capacityScenario(names: typeof SPLIT) {
  const held = task({ id: "H", column: names.hold });
  const occupant = task({ id: "O", column: names.wip });
  const store = storeWith([held, occupant], ir(names), { maxConcurrent: 1 });

  const saturated = await runHoldReleaseSweep(store, { now: () => 1_000_000 });
  occupant.column = names.complete;
  const freed = await runHoldReleaseSweep(store, { now: () => 1_045_000 });

  return {
    heldWhileSaturated: saturated.held.some((h) => h.taskId === "H"),
    heldReason: saturated.held.find((h) => h.taskId === "H")?.reason,
    releasedWhileSaturated: saturated.released,
    releasedOnceFreed: freed.released,
    landedInWipRole: held.column === names.wip,
  };
}

describe("a column carrying BOTH intake and hold (U11's merged Planning column)", () => {
  beforeEach(() => {
    resetHoldReleaseInstrumentation();
    vi.restoreAllMocks();
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
    vi.spyOn(schedulerLog, "warn").mockImplementation(() => {});
  });

  describe("trait resolution", () => {
    it("resolves intake and hold to the SAME column without either role being lost", () => {
      const columns = resolveLifecycleColumns(ir(MERGED));

      expect(columns).toBeDefined();
      expect(columns?.intake).toBe("planning");
      expect(columns?.hold).toBe("planning");
      expect(columns?.wip).toBe("in-progress");
      expect(columns?.complete).toBe("done");
    });

    it("reports the merged column under both trait queries", () => {
      const merged = ir(MERGED);

      expect(columnsWithFlag(merged, "intake")).toContain("planning");
      expect(columnsWithFlag(merged, "hold")).toContain("planning");
    });

    it("rebounds to the merged column (hold wins, and it is the same column as intake)", () => {
      expect(resolveReboundTarget(ir(MERGED))).toBe("planning");
      // Split shape prefers hold over intake — the merged shape must not change that preference,
      // it just makes the two answers coincide.
      expect(resolveReboundTarget(ir(SPLIT))).toBe("todo");
    });
  });

  describe("capacity hold and release", () => {
    it("holds and releases identically whether the pre-implementation roles are split or merged", async () => {
      const split = await capacityScenario(SPLIT);
      resetHoldReleaseInstrumentation();
      const merged = await capacityScenario(MERGED);

      // The split run is not vacuously equal: it really did hold, then release.
      expect(split.heldWhileSaturated).toBe(true);
      expect(split.releasedOnceFreed).toEqual(["H"]);
      expect(split.landedInWipRole).toBe(true);

      // …and the merged column produces the identical role-level outcome.
      expect(merged).toEqual(split);
    });

    it("does not make a card in the merged column INVISIBLE to the sweep", async () => {
      /*
      The failure this unit most fears. An unrecognized pre-implementation column
      produces no decision at all — the card is neither held nor released, which
      presents as a quietly stuck card rather than an error. Assert a positive
      decision was recorded, not merely "it wasn't released".
      */
      const held = task({ id: "H", column: MERGED.hold });
      const occupant = task({ id: "O", column: MERGED.wip });
      const store = storeWith([held, occupant], ir(MERGED), { maxConcurrent: 1 });

      const result = await runHoldReleaseSweep(store, { now: () => 1_000_000 });

      expect(result.held.map((h) => h.taskId)).toContain("H");
      expect(result.held.find((h) => h.taskId === "H")?.reason).toBe("downstream-full");
    });

    it("releases a merged-column card straight into the wip column when capacity is free", async () => {
      const held = task({ id: "H", column: MERGED.hold });
      const store = storeWith([held], ir(MERGED), { maxConcurrent: 5 });

      const result = await runHoldReleaseSweep(store, { now: () => 1_000_000 });

      expect(result.released).toEqual(["H"]);
      expect(held.column).toBe(MERGED.wip);
    });

    it("does not release a merged-column card that is user-paused", async () => {
      const held = task({ id: "H", column: MERGED.hold, userPaused: true, paused: true } as Partial<Task>);
      const store = storeWith([held], ir(MERGED), { maxConcurrent: 5 });

      const result = await runHoldReleaseSweep(store, { now: () => 1_000_000 });

      expect(result.released).not.toContain("H");
      expect(held.column).toBe(MERGED.hold);
    });
  });
  /*
  FNXC:MergedPlanningColumn 2026-07-28-09:55 (U11 precondition):

  `isUnplannedForExecution` decides whether a pre-implementation card may cross into
  execution, and it is the path U11 depends on most: BOTH of its halves ask "what kind
  of column is this card resting in".

  This block exists because the first cut of this file did NOT reach either half — a
  mutation encoding the plausible-but-wrong belief "an intake column has no releaser"
  (`if (currentFlags.intake === true) return false`) left all seven earlier tests GREEN.
  That belief is not hypothetical: it is stated verbatim in
  builtin-plan-review-group.ts's own FNXC comment as the reason plan review lives in
  `todo` today. Under U11 the planning column IS an intake column, so anything encoding
  that belief silently stops holding unplanned cards and they release into
  implementation with a bootstrap stub for a spec.
  */
  describe("the release gate (isUnplannedForExecution)", () => {
    let tasksDir: string;

    beforeEach(() => {
      tasksDir = mkdtempSync(join(tmpdir(), "fusion-u11-merged-"));
    });

    afterEach(() => {
      rmSync(tasksDir, { recursive: true, force: true });
    });

    /** Write the bootstrap stub PROMPT.md that marks a card as not yet specified. */
    function seedUnplannedPrompt(taskId: string, title: string, description: string) {
      mkdirSync(join(tasksDir, taskId), { recursive: true });
      writeFileSync(join(tasksDir, taskId, "PROMPT.md"), buildBootstrapPrompt(taskId, title, description), "utf-8");
    }

    function seedPlannedPrompt(taskId: string) {
      mkdirSync(join(tasksDir, taskId), { recursive: true });
      writeFileSync(join(tasksDir, taskId, "PROMPT.md"), "# Real spec\n\nActual planned work.\n", "utf-8");
    }

    function gateStore(): TaskStore {
      return {
        getTasksDir: () => tasksDir,
        getSettings: vi.fn(async () => ({})),
      } as unknown as TaskStore;
    }

    it("holds an UNPLANNED card resting in the merged intake+hold column", async () => {
      const card = task({ id: "U1", title: "Unplanned", description: "d", column: MERGED.hold });
      seedUnplannedPrompt("U1", "Unplanned", "d");

      await expect(isUnplannedForExecution(gateStore(), card, ir(MERGED))).resolves.toBe(true);
    });

    it("reaches the same verdict for the split shape (the merge changes nothing)", async () => {
      const card = task({ id: "U1", title: "Unplanned", description: "d", column: SPLIT.hold });
      seedUnplannedPrompt("U1", "Unplanned", "d");

      await expect(isUnplannedForExecution(gateStore(), card, ir(SPLIT))).resolves.toBe(true);
    });

    it("releases a PLANNED card from the merged column (the gate is not a blanket hold)", async () => {
      const card = task({ id: "P1", title: "Planned", description: "d", column: MERGED.hold });
      seedPlannedPrompt("P1");

      await expect(isUnplannedForExecution(gateStore(), card, ir(MERGED))).resolves.toBe(false);
    });

    it("holds a card whose PROMPT is only a DUPLICATE redirect (FN-8704)", async () => {
      const card = task({ id: "D1", title: "Dup", description: "d", column: MERGED.hold });
      mkdirSync(join(tasksDir, "D1"), { recursive: true });
      writeFileSync(join(tasksDir, "D1", "PROMPT.md"), "DUPLICATE: FN-8676\n", "utf-8");

      await expect(isUnplannedForExecution(gateStore(), card, ir(MERGED))).resolves.toBe(true);
    });

    /*
    FNXC:DuplicateIntake 2026-08-09-01:54:
    FN-8840 makes the durable title an admission source. Check it without getTasksDir so a store
    adapter cannot accidentally release a title-only custom-prefix redirect while prompt I/O is unavailable.
    */
    it("holds a title-only custom-prefix redirect before prompt filesystem access", async () => {
      const card = task({ id: "D2", title: "DUPLICATE: KB-123", description: "d", column: MERGED.hold });
      const storeWithoutTasksDir = { getSettings: vi.fn(async () => ({})) } as unknown as TaskStore;

      await expect(isUnplannedForExecution(storeWithoutTasksDir, card, ir(MERGED))).resolves.toBe(true);
    });

    it("does not hold incidental duplicate prose in a title", async () => {
      const card = task({ id: "D3", title: "Discuss DUPLICATE: KB-123 before implementation", description: "d", column: MERGED.hold });
      seedPlannedPrompt("D3");

      await expect(isUnplannedForExecution(gateStore(), card, ir(MERGED))).resolves.toBe(false);
    });

    it("does not gate a card already in the wip column", async () => {
      const card = task({ id: "W1", title: "Working", description: "d", column: MERGED.wip });
      seedUnplannedPrompt("W1", "Working", "d");

      await expect(isUnplannedForExecution(gateStore(), card, ir(MERGED))).resolves.toBe(false);
    });
  });
});
