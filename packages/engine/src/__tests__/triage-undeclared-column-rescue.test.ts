/*
FNXC:WorkflowLifecycleColumns 2026-07-29-18:30 (U11 — STALL 3):

#2515 merged Todo into Planning on the default lineage, leaving that workflow with
five columns and NO `triage`. `triage` stayed a legal id (R11, and the Task enum
is a read contract for stored rows), so nothing throws — but planning discovery
resolves a card's lanes from its own workflow, and for a default card BOTH
`intake` and `hold` now resolve to `todo`.

A card SITTING in `triage` therefore matches neither branch and is admitted by
NOTHING. `triage` was the default intake column before #2515, so every existing
project has cards there, and #2515 shipped no data migration re-homing them.

Nothing else rescues them either. #2515's escape hatch makes an undeclared source
column resolve to the workflow's rebound target, so such a card CAN be moved — but
every rebound path (executor, agent-heartbeat, merger) is triggered by ACTIVE work
on the card, and a card parked in Triage has none. It sits until an operator drags
it by hand.

THE FIX NEEDS NO DATA MIGRATION. A card in a column its own workflow does not
declare is, by definition, unowned — no lane's rules apply to it. Admitting it to
PLANNING lets it heal through the normal path: it gets planned, and finalize
releases it to the workflow's hold column, which re-homes the row as a side effect
of ordinary work.

Deliberately narrow. Admission still requires `isTaskStillInPlanningStage`, so a
card that advanced past planning in an undeclared column stays with self-healing's
advanced-recovery sweep rather than being re-specified here.

Written against the post-#2515 implementation and observed FAILING first.
*/
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";

import { TriageProcessor } from "../triage.js";

/* `builtin:coding` resolves to the REAL shipped IR (builtin ids short-circuit the
   store), so the stall test asserts against what #2515 actually merged rather than
   against a fixture that could drift from it. CUSTOM_WF is used where a test needs
   a shape the builtins do not have. */
const WF = "builtin:coding";
const CUSTOM_WF = "custom:wf";

/** The merged default lineage exactly as #2515 shipped it: no `triage` column. */
function mergedDefaultIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "todo", name: "Planning", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", name: "in-progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "in-review", name: "in-review", traits: [{ trait: "review" }] },
      { id: "done", name: "done", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

/** A workflow with a declared column that carries no lifecycle ROLE. */
function irWithUnroledColumn(): WorkflowIr {
  return {
    version: "v2",
    id: CUSTOM_WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "todo", name: "Planning", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
      { id: "design-review", name: "design-review", traits: [] },
      { id: "in-progress", name: "in-progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "done", name: "done", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    title: "t",
    description: "d",
    column: "triage",
    status: null,
    paused: false,
    userPaused: false,
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

function createStore(ir: WorkflowIr, workflowId: string = WF): TaskStore {
  const selection = { workflowId, stepIds: [] };
  return {
    on: vi.fn(),
    off: vi.fn(),
    getTask: vi.fn(async () => undefined),
    listTasks: vi.fn(async () => []),
    getSettings: vi.fn().mockResolvedValue({}),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => ({ ir })),
    /*
    FNXC:WorkflowResolvedColumns 2026-08-01-02:07 REDUNDANT:
    The `resolveTaskWorkflowIrSync` stub remains removed. Re-running
    `pnpm --filter @fusion/engine exec vitest run src/__tests__/triage-undeclared-column-rescue.test.ts --silent=passed-only --reporter=dot`
    passed 7/7. It was redundant because the async readers resolve the test workflow without it.
    FN-8648's corrected tally is six redundant, one deliberate DEFAULT-IR contrast, one masking site.
    */
    logEntry: vi.fn(),
  } as unknown as TaskStore;
}

async function discover(tasks: Task[], ir: WorkflowIr, workflowId?: string): Promise<string[]> {
  const processor = new TriageProcessor(createStore(ir, workflowId), "/test/project");
  const found = await (processor as unknown as {
    discoverReadyPlanningTasks: (t: Task[], now: number) => Promise<Task[]>;
  }).discoverReadyPlanningTasks(tasks, Date.parse("2026-02-01T00:00:00.000Z"));
  return found.map((t) => t.id);
}

describe("planning discovery rescues a card stranded in an undeclared column", () => {
  it("admits a card sitting in `triage` after #2515 removed that column", async () => {
    /*
    THE STALL. Every project upgrading from before #2515 has cards here, and
    discovery admitted none of them.
    */
    expect(await discover([task({ column: "triage" })], mergedDefaultIr())).toEqual(["FN-1"]);
  });

  it("does NOT admit a card in an undeclared column that already advanced past planning", async () => {
    /*
    The narrowing that keeps this from stealing self-healing's work: an undeclared
    column is not a licence to re-specify a card that already executed.
    */
    expect(
      await discover(
        [task({ column: "triage", steps: [{ id: "s1" } as never], firstExecutionAt: "2026-01-02T00:00:00.000Z" })],
        mergedDefaultIr(),
      ),
    ).toEqual([]);
  });

  it("does NOT admit a card in a DECLARED column that merely carries no role", async () => {
    /*
    The direction that would be a real regression. `design-review` is declared, so
    its workflow owns that card and planning must keep its hands off — "undeclared"
    has to mean undeclared, not merely unroled.
    */
    expect(await discover([task({ column: "design-review" })], irWithUnroledColumn(), CUSTOM_WF)).toEqual([]);
  });

  it("still admits a card resting in the declared intake column", async () => {
    /* The pre-existing rule must survive. */
    expect(await discover([task({ column: "todo" })], mergedDefaultIr())).toEqual(["FN-1"]);
  });

  it("never admits a paused card from an undeclared column", async () => {
    /* The user-pause safeguard outranks every rescue. */
    expect(await discover([task({ column: "triage", paused: true })], mergedDefaultIr())).toEqual([]);
    expect(await discover([task({ column: "triage", userPaused: true })], mergedDefaultIr())).toEqual([]);
  });

  it("does NOT rescue a workflow-specific column, even when undeclared", async () => {
    /*
    The narrowing, and the lesson from `triage.test.ts`. A card can sit in a column
    its workflow genuinely owns while the SELECTION fails to resolve — the resolved
    default IR then does not declare that column either, and an "any undeclared
    column" rescue re-specifies it. That is how the first version of this change
    broke FN-7596's manual-intake rule, which requires an OPERATOR to promote an
    `ideas` card rather than planning auto-claiming it.
    */
    expect(await discover([task({ column: "ideas" })], mergedDefaultIr())).toEqual([]);
  });

  it("does not admit a card in a terminal column of its own workflow", async () => {
    /* `done` is declared, so it is owned and must never be re-planned. */
    expect(await discover([task({ column: "done" })], mergedDefaultIr())).toEqual([]);
  });
});
