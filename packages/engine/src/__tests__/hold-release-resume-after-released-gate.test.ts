/*
FNXC:ResumePlacement 2026-11-01-20:25 (RUFU-300):
THE SECOND ACTOR: getting the card OUT of the planning lane.

`resume-placement-after-passed-gate.test.ts` proves the graph parks a released-gate card AT the
ready-for-release seam and moves nothing (KTD-2). The promised operator outcome — an approved card
resumes its work instead of sitting in Planning — is produced by a DIFFERENT authority,
`packages/engine/src/execution/hold-release.ts`, which is the sole mover across a `hold → wip`
boundary. This file asserts that half, and then composes the two:

  (b-2) a card resting at the seam whose latest `plan-review` row is `passed` is admitted to the
        execution lane by exactly one mover, and a card with NO released-gate evidence is refused the
        same admission (so the release cannot be turned into an unconditional advance);
  (b-3) graph run → parked at the seam → scheduler release → second graph run: the card resumes at
        `parse`, reaches step execution, and keeps the 9-step ledger it already had.

Leg (b-2) was ALREADY GREEN before this task's production change and is kept green deliberately:
RUFU-292's single `passed` row satisfies core's `isPlanReviewSatisfied`, so the release gate was never
the failure. Recording that here is what stops the next reader from "fixing" a release leg that was
working and leaving the real culprit — pre-session placement churn — untouched.

The premises gate answers from COMMITTED git objects at the card's own identity, so the fixture's
"project" is a real repository with the premise file committed on the integration branch (the same
reason `hold-release-awaiting-planning.test.ts` builds one). No real AI, no real worktree, no network.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLAN_REVIEW_GROUP_ID, type Task, type TaskStore } from "@fusion/core";

import {
  promoteHeldTask,
  resetHoldReleaseInstrumentation,
  runHoldReleaseSweep,
} from "../execution/hold-release.js";
import { getPromptPath } from "../execution/spec-staleness.js";
import {
  codingIr,
  PINNED_STEPS,
  rufu292Task,
  settingsOn,
  wiredHarness,
} from "./fixtures/resume-placement-harness.js";

const roots: string[] = [];

/** One card object drives BOTH halves: the release fixture mutates it, the graph run reads it. */
function seededTask(over: Partial<Task> = {}): Task {
  const seed = rufu292Task();
  return {
    ...seed,
    id: "RUFU-300-CHAIN",
    status: null,
    columnMovedAt: "2026-09-24T00:00:00.000Z",
    ...over,
  } as unknown as Task;
}

/**
 * The card's PROMPT.md has to satisfy two authorities at once: the release premises gate (`## Plan
 * Premises`, verified against committed objects) and the `parse-steps` node (`## Steps`, the source of
 * the 9-step ledger). One document, both sections — a prompt that only satisfied one of them would
 * test a card that cannot exist.
 */
function promptWithBothSections(): string {
  const steps = Array.from(
    { length: 9 },
    (_unused, index) => `### Step ${index}: Step ${index}\n- [ ] do it ${index}\n`,
  ).join("\n");
  return [
    "# Task",
    "",
    "## Mission",
    "Implement the approved work.",
    "",
    "## Plan Premises",
    "",
    '- {"kind":"file-exists","path":"premise-marker"}',
    "",
    "## Steps",
    "",
    steps,
  ].join("\n");
}

function commitAsTrunk(root: string): void {
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git(["init", "-q", "-b", "main", "."]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test User"]);
  git(["add", "premise-marker"]);
  git(["commit", "-qm", "chore: premise marker"]);
}

async function makeStore(task: Task) {
  const root = await mkdtemp(join(tmpdir(), "fusion-rufu-300-"));
  roots.push(root);
  const tasksDir = join(root, "tasks");
  await mkdir(join(tasksDir, task.id), { recursive: true });
  await writeFile(join(root, "premise-marker"), "planned", "utf8");
  await writeFile(getPromptPath(tasksDir, task.id), promptWithBothSections(), "utf8");
  commitAsTrunk(root);

  const current = task;
  /*
  FNXC:ResumePlacement 2026-11-03-14:23 (RUFU-300):
  The predicate is `boolean | Promise<boolean>` (`moveTaskIf` in `packages/core/src/task-store/moves.ts`
  AWAITS it), and the release door's predicate is async: under the move lock it runs `checkPlanPremises`,
  which reads the card's git identity from COMMITTED objects. A fake that tests the predicate's
  truthiness without awaiting it always sees a truthy Promise, so it (a) never takes the refusal branch
  the door just decided — turning a refusal into a move — and (b) abandons the door's git read, which the
  vitest child-process guard then reports as a process left running. Await the predicate: the fake
  respects the same contract production does, and the premises verdict becomes evidence-driven.
  */
  const moveTaskIf = vi.fn(async (
    _id: string,
    target: string,
    predicate: (live: Task) => boolean | Promise<boolean>,
  ) => {
    if (!await predicate(current)) return { task: current, moved: false };
    current.column = target;
    return { task: current, moved: true };
  });
  const updateTask = vi.fn(async (_id: string, patch: Partial<Task>) => {
    Object.assign(current, patch);
    return current;
  });
  const selection = { workflowId: "builtin:coding", stepIds: [] };
  const store = {
    getSettings: vi.fn(async () => ({ maxConcurrent: 4, autoMerge: true })),
    listTasks: vi.fn(async () => [current]),
    getTask: vi.fn(async () => current),
    getTasksDir: () => tasksDir,
    getRootDir: () => root,
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getTaskWorkflowSelectionsAsync: vi.fn(async () => new Map([[current.id, selection]])),
    getWorkflowDefinition: vi.fn(async () => undefined),
    listWorkflowWorkItemsForTask: vi.fn(async () => []),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    checkAndRecordUnplannedExecutionBlock: vi.fn(async () => false),
    moveTaskIf,
    updateTask,
    updateTaskAtomic: vi.fn(async (_id: string, mutate: (live: Task) => Partial<Task> | null | Promise<Partial<Task> | null>) => {
      const patch = await mutate(current);
      if (patch) Object.assign(current, patch);
      return current;
    }),
    logEntry: vi.fn(async (_id: string, message: string) => {
      current.log.push({ timestamp: new Date().toISOString(), message } as Task["log"][number]);
    }),
    recordRunAuditEvent: vi.fn(async () => undefined),
  } as unknown as TaskStore;

  return { store, current, moveTaskIf };
}

beforeEach(() => {
  resetHoldReleaseInstrumentation();
  vi.restoreAllMocks();
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("RUFU-300 (b-2) — the scheduler is the one that releases the parked card", () => {
  it("releases a card resting at the seam whose latest plan-review row is `passed`", async () => {
    const task = seededTask();
    const fixture = await makeStore(task);

    await expect(runHoldReleaseSweep(fixture.store, { now: () => Date.now() }))
      .resolves.toMatchObject({ released: [task.id] });

    expect(task.column).toBe("in-progress");
    // Exactly one mover recorded the crossing, and it was the scheduler, not the graph.
    expect(fixture.moveTaskIf).toHaveBeenCalledTimes(1);
    expect(fixture.moveTaskIf.mock.calls[0]![1]).toBe("in-progress");
  });

  it("refuses the same admission for a card with NO released-gate evidence (control)", async () => {
    // The identical card, identical lane, identical pin — minus the `passed` row. The release gate
    // advances a card on its EVIDENCE, never on the mere fact that a run wanted to move forward.
    const task = seededTask({ workflowStepResults: [] });
    const fixture = await makeStore(task);

    const result = await runHoldReleaseSweep(fixture.store, { now: () => Date.now() });

    expect(result.released).not.toContain(task.id);
    expect(task.column).toBe("todo");
    expect(fixture.moveTaskIf).not.toHaveBeenCalled();
  });

  it("refuses an explicit promotion for the same unevidenced card", async () => {
    const task = seededTask({ workflowStepResults: [] });
    const fixture = await makeStore(task);

    await expect(promoteHeldTask(fixture.store, task.id)).resolves.toMatchObject({ released: false });
    expect(task.column).toBe("todo");
    expect(fixture.moveTaskIf).not.toHaveBeenCalled();
  });

  it("admits an explicit promotion for the released-gate card", async () => {
    const task = seededTask();
    const fixture = await makeStore(task);

    await expect(promoteHeldTask(fixture.store, task.id)).resolves.toMatchObject({ released: true });
    expect(task.column).toBe("in-progress");
  });
});

describe("RUFU-300 (b-3) — the composed chain reaches the work and keeps its progress", () => {
  it("parks at the seam, is released by the scheduler, then resumes at `parse` and executes", async () => {
    // RUFU-292's OWN state: the ledger is parsed but untouched, so `parse` is the legal placement —
    // there is no durable progress there to destroy. A card that HAS progress is the next leg.
    const task = seededTask();
    const fixture = await makeStore(task);

    // ACTOR 1 — the graph: placed behind the released gate, parked AT the seam, moves nothing.
    const first = wiredHarness(task);
    const firstRun = await first.executor.run(task as never, settingsOn(), codingIr);
    /*
     * FNXC:RunAuditCapacityDiagnostic 2026-11-03-15:15 (RUFU-300 merge repair):
     * RUFU-372's second slice relabelled the hold→wip seam park from `capacity` to
     * `scheduler-owned-seam`. The seam is still the seam: the graph moves nothing and the release sweep
     * still releases it below, because the continuation's `waitReason` stays `capacity` by the
     * documented no-migration contract.
     */
    expect(firstRun.suspended).toMatchObject({ reason: "scheduler-owned-seam", nodeId: "parse", toColumn: "in-progress" });
    expect(first.moves).toHaveLength(0);
    expect(task.column).toBe("todo");

    /*
     * FINDING recorded here (RUFU-300 Step 2, measurement kept as evidence): the parse-steps runner
     * rebuilds every step as `{ name, status: "pending" }` and the production write seam patches
     * `steps` wholesale (`build-parse-steps-deps.ts`), so a parse-only re-entry of a card seeded
     * `done,done,done,pending…` with `currentStep: 3` ended `pending` × 9 with `currentStep` STILL 3 —
     * a ledger/cursor disagreement, and its KTD-3 expansion guard only protects a foreach expanded in
     * the SAME run. Placement is the layer that can avoid that without touching either file, so the
     * progressed card below is placed at the `foreach` that consumes the ledger instead.
     */
    // ACTOR 2 — the scheduler: the only body allowed to cross hold→wip.
    await expect(runHoldReleaseSweep(fixture.store, { now: () => Date.now() }))
      .resolves.toMatchObject({ released: [task.id] });
    expect(task.column).toBe("in-progress");
    const movesAfterRelease = fixture.moveTaskIf.mock.calls.length;

    // ACTOR 1 again — the resumed run now enters the lane its pin already named, runs the parsed
    // steps, and leaves the ledger it found intact rather than re-parsing or re-zeroing it.
    const second = wiredHarness(task, { initialColumn: "in-progress" });
    const secondRun = await second.executor.run(task as never, settingsOn(), codingIr);

    expect(secondRun.visitedNodeIds[0]).toBe("parse");
    expect(secondRun.visitedNodeIds).not.toContain("start");
    expect(secondRun.visitedNodeIds).not.toContain("plan");
    expect(secondRun.visitedNodeIds).not.toContain("plan-review");
    // The chain reached the parsed-step execution region rather than stopping at the seam again. The
    // `steps` node is a foreach, so its instances visit as `steps#N:step-execute`.
    expect(secondRun.visitedNodeIds).toContain("steps");
    expect(secondRun.visitedNodeIds.some((id) => id.includes("step-execute"))).toBe(true);
    expect(second.calls).toContain("step-execute");
    // The ledger is the SAME ledger: nine steps, the same identities, nothing re-created, and the
    // untouched cursor still reads 0.
    expect(task.steps).toHaveLength(PINNED_STEPS.length);
    expect(task.steps.map((step) => step.name)).toEqual(PINNED_STEPS.map((step) => step.name));
    expect(task.steps.every((step) => step.status === "pending")).toBe(true);
    expect(task.currentStep).toBe(0);
    // The graph crossed no boundary of its own INTO or OUT OF the planning lane: the release remains
    // the single mover across hold→wip. (Downstream review-lane crossings are the graph's own legal
    // business and the boundary records them — KTD-2 is about the planning seam, not about the run.)
    expect(second.moves.every((move) => move.toColumn !== "todo" && move.fromColumn !== "todo")).toBe(true);
    expect(fixture.moveTaskIf).toHaveBeenCalledTimes(movesAfterRelease);
  });

  /*
  FNXC:ResumePlacement 2026-11-01-19:40 (RUFU-300):
  The same chain for a card that already has work on the books. "Never replay a released gate" and
  "never reset durable progress" collide here if placement is decided by the column alone: the column
  answer is `parse`, and `parse` rewrites the ledger. The chain therefore has to prove both halves at
  once — the gate is still not replayed, and the progress still survives the re-entry.
  */
  it("resumes a card whose ledger already shows progress without rewriting it", async () => {
    const task = seededTask();
    task.steps = PINNED_STEPS.map((step, index) => ({
      ...step,
      status: index < 3 ? "done" as const : "pending" as const,
    }));
    task.currentStep = 3;
    const fixture = await makeStore(task);

    // ACTOR 1 — parked at the seam, now AT the step region rather than at the ledger-rewriting node.
    const first = wiredHarness(task);
    const firstRun = await first.executor.run(task as never, settingsOn(), codingIr);
    /* Seams are labelled `scheduler-owned-seam` since RUFU-372's reason split (see the leg above). */
    expect(firstRun.suspended).toMatchObject({ reason: "scheduler-owned-seam", nodeId: "steps", toColumn: "in-progress" });
    expect(first.moves).toHaveLength(0);

    // ACTOR 2 — the release.
    await expect(runHoldReleaseSweep(fixture.store, { now: () => Date.now() }))
      .resolves.toMatchObject({ released: [task.id] });
    expect(task.column).toBe("in-progress");

    // ACTOR 1 again — the released gate is still never replayed, and the ledger is not rewritten.
    const second = wiredHarness(task, { initialColumn: "in-progress" });
    const secondRun = await second.executor.run(task as never, settingsOn(), codingIr);

    expect(secondRun.visitedNodeIds).not.toContain("start");
    expect(secondRun.visitedNodeIds).not.toContain("plan");
    expect(secondRun.visitedNodeIds).not.toContain("plan-review");
    expect(secondRun.visitedNodeIds).not.toContain("parse");
    // Resumed at the FIRST UNFINISHED iteration — not at iteration 0, and not from a re-parsed ledger.
    expect(secondRun.visitedNodeIds).toContain("steps#3:step-execute");
    expect(secondRun.visitedNodeIds.some((id) => id === "steps#0:step-execute")).toBe(false);
    expect(second.calls).toContain("step-execute");
    expect(task.steps).toHaveLength(PINNED_STEPS.length);
    expect(task.steps.slice(0, 3).every((step) => step.status === "done")).toBe(true);
    expect(task.currentStep).toBe(3);
    expect(second.moves.every((move) => move.toColumn !== "todo" && move.fromColumn !== "todo")).toBe(true);
  });
});

describe("RUFU-300 — the shipped Plan Review gate identity this contract reads", () => {
  it("the release gate and the placement resolver name the same gate node", () => {
    // Placement releases `plan-review` by node id; the release gate reads the same id through core's
    // PLAN_REVIEW_GROUP_ID. If those two ever disagree, one of the two halves silently stops working.
    expect(PLAN_REVIEW_GROUP_ID).toBe("plan-review");
    const released = seededTask().workflowStepResults?.[0]?.workflowStepId;
    expect(released).toBe(PLAN_REVIEW_GROUP_ID);
  });
});
