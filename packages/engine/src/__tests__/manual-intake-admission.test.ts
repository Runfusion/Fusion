/*
FNXC:ManualIntakeAdmission 2026-07-30-04:35 (live bug, found while scoping the coding-ideas merge):

THE INVARIANT: a card sitting at a MANUAL intake (`autoTriage: false`) is never auto-planned. Coding
(Ideas) exists so an operator can park a card without the engine touching it; the operator promotes
it into Planning when ready (FN-7596).

IT WAS BROKEN, and it was broken BY the trait conversion. The rule used to be enforced accidentally,
by discovery's predicate naming `triage`: an `ideas` card matched no branch. Converting that predicate
to resolve intake BY TRAIT made `ideas` the resolved intake column for that workflow — so discovery
began specifying parked ideas. Same shape as every other half-conversion in this program: correct in
vocabulary, wrong in effect, and wider than before.

MEASURED BEFORE THE FIX, with a store that can actually resolve the workflow: `poll()` called
`specifyTask` once, with the parked `ideas` card.

WHY THE EXISTING GUARD MISSED IT. `triage.test.ts`'s "excludes a parked ideas-column task from the
poll's specify-dispatch set" builds a mock store with NO workflow readers, so lifecycle resolution
falls back to `triage`/`todo` and an `ideas` card matches neither branch. It passes for a reason
unrelated to the rule and kept passing after the rule broke. Its own comment still describes the old
mechanism — "`eligibleTriageTasks`, which only matches `column === "triage"`" — which is the tell.

So this file's store RESOLVES the workflow. That single difference is the whole point: a test whose
fixture cannot reach the code path proves nothing about it.

SURFACE ENUMERATION (AGENTS.md requires this for a bug-class fix; here is what was checked, not
assumed):

  1. TRIAGE DISCOVERY -> `specifyTask`. BOTH dispatch sites (`triage.ts` ~536 via the admission
     coordinator, and ~1985 via the poll) call `discoverReadyPlanningTasks`, so the gate has ONE
     home. Covered by this suite, driving `poll()`.
  2. HOLD-RELEASE into WIP (`issueRelease` / `reserveSlot` / `promoteHeldTask` /
     `releaseHeldTaskByEvent`). Safe already: `isUnplannedForExecution` holds a card whose PROMPT.md
     is still the bootstrap stub while it rests in an `intake`-trait column, and a parked idea is by
     definition unplanned. Nothing to change — the release surfaces share that one predicate.
  3. SELF-HEALING's stranded-hold continuation. Candidate requires a REAL spec; a parked idea has a
     bootstrap stub, so it is not a candidate.
  4. SCHEDULER dispatch. Reads WIP-bound work from the hold column, and reaches a card only after
     release, which (2) gates.
  5. OPERATOR-TRIGGERED re-specification (a user comment on a parked card). Deliberately NOT gated:
     that is an operator acting on their own card, which is the promotion path, not auto-planning.

CONSEQUENCE FOR THE CODING-IDEAS MERGE (ideas + todo -> one Planning column): it cannot be reasoned
about until this signal exists, because merging makes `intake === hold` and the two admission branches
collapse onto one column. With `manualIntake` honoured, a merged manual lane parks correctly and is
released by promotion; without it, merging would auto-plan every captured card. Recorded here because
the merge is owed work and this is its blocker.
*/
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";
import { BUILTIN_CODING_IDEAS_WORKFLOW_IR } from "@fusion/core";

import { TriageProcessor } from "../triage.js";

function parkedTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-IDEAS",
    description: "a parked idea",
    column: "ideas",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as unknown as Task;
}

/** A store that CAN resolve the workflow — the difference that makes this suite able to fail. */
function resolvingStore(tasks: Task[], ir: WorkflowIr, workflowId = "builtin:coding-ideas-v2"): TaskStore {
  const selection = { workflowId, stepIds: [] as string[] };
  return Object.assign(new EventEmitter(), {
    listTasks: vi.fn().mockResolvedValue(tasks),
    getTask: vi.fn(async (id: string) => tasks.find((t) => t.id === id)),
    getSettings: vi.fn().mockResolvedValue({
      maxConcurrent: 10,
      maxWorktrees: 4,
      pollIntervalMs: 10_000,
      autoMerge: true,
    }),
    logEntry: vi.fn().mockResolvedValue(undefined),
    updateTask: vi.fn().mockResolvedValue(undefined),
    withTaskLock: vi.fn(async (_id: string, callback: () => unknown) => callback()),
    getTaskWorkflowSelection: () => selection,
    getTaskWorkflowSelectionAsync: async () => selection,
    getWorkflowDefinition: async () => ({ ir }),
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
  }) as unknown as TaskStore;
}

async function pollWith(store: TaskStore): Promise<string[]> {
  const processor = new TriageProcessor(store, "/tmp/manual-intake-admission");
  const specify = vi.spyOn(processor, "specifyTask").mockResolvedValue(undefined);
  (processor as unknown as { running: boolean }).running = true;
  await (processor as unknown as { poll: () => Promise<void> }).poll();
  return specify.mock.calls.map((call) => (call[0] as Task)?.id);
}

describe("a card parked at a manual intake is never auto-planned", () => {
  it("does not specify a parked `ideas` card on the real Coding (Ideas) workflow", async () => {
    // Pre-fix, measured: this specified FN-IDEAS. The operator's parked capture was planned for them.
    const specified = await pollWith(
      resolvingStore([parkedTask()], BUILTIN_CODING_IDEAS_WORKFLOW_IR),
    );

    expect(specified).toEqual([]);
  });

  it("DOES specify a card the operator promoted into Planning", async () => {
    /*
    The paired positive, and the reason the fix is scoped to the INTAKE branch: a card in the hold
    column was released there by an operator or by finalize. "Manual intake" says nothing about a card
    that has already left it, so gating the hold branch too would park Coding (Ideas) permanently.
    */
    const promoted = parkedTask({ id: "FN-PROMOTED", column: "todo" } as Partial<Task>);
    const specified = await pollWith(
      resolvingStore([promoted], BUILTIN_CODING_IDEAS_WORKFLOW_IR),
    );

    expect(specified).toEqual(["FN-PROMOTED"]);
  });

  /*
  FNXC:DependencyReplanManualIntake 2026-08-19-02:45:
  Dependency invalidation preserves the existing PROMPT.md, so triage must admit a promoted Planning
  card marked `needs-replan` even when it already has a real specification. The parked Ideas card remains
  excluded by the same real workflow selection.
  */
  it("discovers a promoted Planning card marked needs-replan even with an existing prompt", async () => {
    const replan = parkedTask({
      id: "FN-REPLAN",
      column: "todo",
      status: "needs-replan",
      prompt: "# Existing specification\n\n## Steps\n\n1. Keep it\n",
    } as Partial<Task>);
    const specified = await pollWith(
      resolvingStore([replan], BUILTIN_CODING_IDEAS_WORKFLOW_IR),
    );

    expect(specified).toEqual(["FN-REPLAN"]);
  });

  it("still auto-plans an AUTO intake, so the fix is not 'never admit at intake'", async () => {
    // The default lineage's intake carries no `autoTriage: false`, and post-U11 it is the same column
    // as the hold lane. A fix that keyed on "is intake" rather than "is MANUAL intake" would have
    // stopped the default board planning anything.
    const autoIntakeIr = {
      version: "v2", id: "wf-auto", name: "auto-intake", nodes: [], edges: [],
      columns: [
        {
          id: "todo",
          name: "Planning",
          traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }],
        },
        { id: "in-progress", name: "Wip", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
        { id: "in-review", name: "Review", traits: [{ trait: "merge" }] },
        { id: "done", name: "Done", traits: [{ trait: "complete" }] },
      ],
    } as unknown as WorkflowIr;

    const specified = await pollWith(
      resolvingStore([parkedTask({ id: "FN-AUTO", column: "todo" } as Partial<Task>)], autoIntakeIr, "wf-auto"),
    );

    expect(specified).toEqual(["FN-AUTO"]);
  });

  it("keeps admitting on a workflow that cannot be resolved at all", async () => {
    // No workflow readers is the legacy shape: lifecycle falls back to `triage`/`todo`, and a card
    // there must still be planned. This is also, precisely, why the pre-existing guard in
    // triage.test.ts cannot see the bug above — its fixture is this case.
    const legacyStore = Object.assign(new EventEmitter(), {
      listTasks: vi.fn().mockResolvedValue([parkedTask({ id: "FN-LEGACY", column: "triage" } as Partial<Task>)]),
      getTask: vi.fn(async () => parkedTask({ id: "FN-LEGACY", column: "triage" } as Partial<Task>)),
      getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 10, maxWorktrees: 4, pollIntervalMs: 10_000, autoMerge: true }),
      logEntry: vi.fn().mockResolvedValue(undefined),
      updateTask: vi.fn().mockResolvedValue(undefined),
      withTaskLock: vi.fn(async (_id: string, callback: () => unknown) => callback()),
      recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    }) as unknown as TaskStore;

    expect(await pollWith(legacyStore)).toEqual(["FN-LEGACY"]);
  });
});
