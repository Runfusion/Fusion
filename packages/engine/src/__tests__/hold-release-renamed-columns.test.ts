/*
FNXC:WorkflowLifecycleColumns 2026-07-27-22:10 (Phase B / slice B2):

NEGATIVE RESULT, pinned deliberately. The Phase B plan named hold-release as a
conversion target: "release readiness must hold and release identically for a
RENAMED hold column." These tests were written FIRST, against unmodified
hold-release.ts, to prove that scenario BROKEN. It is not broken — every
assertion below passed on the first run with no production change. hold-release
was already converted to trait resolution by U6/KTD-5 (`isAtHoldColumn`,
`resolveReleaseTarget`, and `dependencySatisfied` all resolve the task's IR
rather than comparing against a literal id), so slice B2 has no work to do here.

They are kept as a REGRESSION FLOOR rather than deleted. The invariant is
currently upheld by three separate trait resolutions, any one of which could be
"simplified" back to a literal id by a later change; nothing else in the suite
covers the renamed-column shape end-to-end through the sweep. A test that has
never failed is weak evidence on its own — its value here is that it is
differential: it runs the SAME scenario against default-named and renamed
workflows and asserts the outcomes match, so it fails if a literal creeps back
into any of the three paths.

The one literal that remains in this module — `legacyDependencySatisfied`'s
`done`/`in-review`/`archived` check at hold-release.ts:326 — is deliberately NOT
converted. It is the FN-5719 DUAL-ACCEPT half that honors the legacy completion
signal and logs an audit diff when the two halves disagree; converting it would
delete a compatibility signal rather than fix a bug. The renamed workflow below
is satisfied through the TRAIT half, which is the point: the literal half is
additive, not load-bearing, for a renamed workflow.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";

import { runHoldReleaseSweep, resetHoldReleaseInstrumentation } from "../hold-release.js";
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
 * The same workflow SHAPE under two vocabularies. `names` supplies the column
 * ids; the traits — which are what the sweep actually reasons about — are
 * identical in both. Any behavioral difference between the two is therefore
 * attributable to a surviving column-id literal and nothing else.
 */
function ir(
  names: { hold: string; wip: string; complete: string },
  release: "capacity" | "dependency" = "capacity",
): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: names.hold, label: "Hold", traits: [{ trait: "hold", config: { release } }] },
      { id: names.wip, label: "Wip", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: names.complete, label: "Complete", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

const DEFAULT_NAMES = { hold: "todo", wip: "in-progress", complete: "done" };
/* Every role renamed, and deliberately NONE of the renamed ids collides with a
   legacy literal — so a surviving `=== "todo"` comparison cannot pass by luck. */
const RENAMED = { hold: "drafting", wip: "building", complete: "shipped" };

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

/**
 * Run the capacity-hold scenario under one vocabulary and report the outcome in
 * ROLE terms (not column ids) so the two runs are directly comparable.
 */
async function capacityScenario(names: { hold: string; wip: string; complete: string }) {
  const held = task({ id: "H", column: names.hold });
  const occupant = task({ id: "O", column: names.wip });
  const store = storeWith([held, occupant], ir(names), { maxConcurrent: 1 });

  // Pass 1 — the single wip slot is occupied, so the card must be HELD.
  const saturated = await runHoldReleaseSweep(store, { now: () => 1_000_000 });

  // Pass 2 — the occupant leaves for the complete column, freeing the slot.
  occupant.column = names.complete;
  const freed = await runHoldReleaseSweep(store, { now: () => 1_045_000 });

  return {
    heldWhileSaturated: saturated.held.some((h) => h.taskId === "H"),
    heldReason: saturated.held.find((h) => h.taskId === "H")?.reason,
    releasedWhileSaturated: saturated.released,
    releasedOnceFreed: freed.released,
    // Reported as "did it land in the WIP role", not "did it land in in-progress".
    landedInWipRole: held.column === names.wip,
  };
}

describe("hold/release under a renamed column vocabulary", () => {
  beforeEach(() => {
    resetHoldReleaseInstrumentation();
    vi.restoreAllMocks();
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
    vi.spyOn(schedulerLog, "warn").mockImplementation(() => {});
  });

  it("holds and releases a capacity-held card identically whether or not the columns are renamed", async () => {
    const legacy = await capacityScenario(DEFAULT_NAMES);
    resetHoldReleaseInstrumentation();
    const renamed = await capacityScenario(RENAMED);

    // The renamed run is not vacuously equal: it really did hold, then release.
    expect(legacy.heldWhileSaturated).toBe(true);
    expect(legacy.releasedOnceFreed).toEqual(["H"]);
    expect(legacy.landedInWipRole).toBe(true);

    // …and the renamed vocabulary produces the identical role-level outcome.
    expect(renamed).toEqual(legacy);
  });

  it("recognizes a renamed hold column as a hold at all (the card is not simply ignored)", async () => {
    /*
    Guards the failure mode a naive equality check would produce: not a wrong
    release, but NO decision — an unrecognized hold column makes the card
    invisible to the sweep, which looks like a quiet, permanently-stuck card
    rather than an error.
    */
    const held = task({ id: "H", column: RENAMED.hold });
    const occupant = task({ id: "O", column: RENAMED.wip });
    const store = storeWith([held, occupant], ir(RENAMED), { maxConcurrent: 1 });

    const result = await runHoldReleaseSweep(store, { now: () => 1_000_000 });

    expect(result.held.map((h) => h.taskId)).toContain("H");
    expect(result.held.find((h) => h.taskId === "H")?.reason).toBe("downstream-full");
  });

  it("releases into the workflow's own wip column, never into a literal 'in-progress'", async () => {
    const held = task({ id: "H", column: RENAMED.hold });
    const store = storeWith([held], ir(RENAMED), { maxConcurrent: 5 });

    const result = await runHoldReleaseSweep(store, { now: () => 1_000_000 });

    expect(result.released).toEqual(["H"]);
    expect(held.column).toBe(RENAMED.wip);
    expect(held.column).not.toBe("in-progress");
  });

  /*
  These two use a `dependency` hold, NOT a capacity hold. A capacity hold never
  consults dependencies at all (hold-release.ts dispatches on the hold's
  `release` kind), so the same scenario under `release: "capacity"` releases the
  card on the free slot and would assert nothing about dependency satisfaction.
  The first draft of this file made exactly that mistake and passed vacuously.
  */
  it("satisfies a dependency through the COMPLETE trait when the complete column is renamed", async () => {
    /*
    FN-5719 dual-accept: `dependencySatisfied` ORs a trait check against the
    legacy done/in-review/archived literal. A renamed complete column
    ("shipped") matches ONLY the trait half, so this asserts the half that
    survives a rename — and would fail if the trait half were ever dropped in
    favor of the literal one.
    */
    const dep = task({ id: "DEP", column: RENAMED.complete });
    const held = task({ id: "H", column: RENAMED.hold, dependencies: ["DEP"] });
    const store = storeWith([held, dep], ir(RENAMED, "dependency"), { maxConcurrent: 5 });

    const result = await runHoldReleaseSweep(store, { now: () => 1_000_000 });

    expect(result.released).toEqual(["H"]);
    expect(held.column).toBe(RENAMED.wip);
  });

  it("still blocks on an unsatisfied dependency under the renamed vocabulary", async () => {
    /* The negative half — otherwise the test above would pass even if
       dependencies were not being evaluated at all under a renamed workflow. */
    const dep = task({ id: "DEP", column: RENAMED.wip });
    const held = task({ id: "H", column: RENAMED.hold, dependencies: ["DEP"] });
    const store = storeWith([held, dep], ir(RENAMED, "dependency"), { maxConcurrent: 5 });

    const result = await runHoldReleaseSweep(store, { now: () => 1_000_000 });

    expect(result.released).toEqual([]);
    expect(result.held.find((h) => h.taskId === "H")?.reason).toBe("deps-unsatisfied");
    expect(held.column).toBe(RENAMED.hold);
  });
});
