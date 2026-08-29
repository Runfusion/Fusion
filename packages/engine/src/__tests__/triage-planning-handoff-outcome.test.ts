/*
FNXC:PlanningHandoffOutcome 2026-07-28-09:20 (U7 / R4, R12 — workflow-owned lifecycle):

THE INVARIANT: a finalize pass reports what it actually did with the card, and
"could not hand it off" is distinguishable from "handed it to a human".

Finalize has ~25 exit points and returned `void`. Both callers therefore assumed
success. This suite covers the caller that is reachable through a public method —
`recoverApprovedTask`, which returned `true` UNCONDITIONALLY after finalize:

  - `handleStuckAbortRequeue` treats a `true` recovery as "done, stop here".
  - So a card whose release move was REFUSED by the planning-stage guard (FN-8361),
    or whose store could not perform the move at all, was reported as recovered.
  - Its stuck-retry budget was then skipped: nothing re-planned it, nothing
    escalated it, and it sat in the planner column holding a finished spec.

WHY THREE STATES AND NOT A BOOLEAN. `parked` must keep returning `true`. An
awaiting-approval park is a SUCCESSFUL recovery outcome — the card is exactly where
the operator's pending decision put it. Returning `false` there would send the
stuck handler down its draft path and stamp `needs-replan` over a plan a human is
in the middle of reviewing, which is a worse bug than the one being fixed. The
approval case below is therefore a load-bearing control, not a courtesy test.

SCOPE. The other caller — `specifyTask`'s unconditional `onSpecifyComplete` — is
not exercised here: reaching it requires a live planning session. Its gating lands
with the runtime-reaction extraction, for the same reason the continuation drain
had to be extracted in PR #2491 before its wiring could be proven. The plumbing
this suite pins is what that change will consume.

Every test below fails with `report.outcome`/`recoverApprovedTask`'s return
reverted — see the PR body for the measured revert run.
*/
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";

import { TriageProcessor } from "../triage.js";
import { planLog } from "../logger.js";

/** A spec that clears deterministic validation and the step-headings requirement. */
const REAL_SPEC = [
  "# Task: FN-001 - Real spec",
  "",
  "## Mission",
  "",
  "Do the thing.",
  "",
  "## Steps",
  "",
  "### Step 0: Implement",
  "- [ ] do the work",
  "",
].join("\n");

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-001",
    title: "Task",
    description: "desc",
    column: "triage",
    status: "planning",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

/**
 * `moveTaskIfResult` is the seam under test: it models what the store's
 * planning-stage-guarded release move decided. `undefined` removes the method
 * entirely, which is the "store cannot perform the move" branch.
 */
function createStore(opts: {
  task: Task;
  settings?: Partial<Settings>;
  moveTaskIfResult?: "moved" | "refused" | "absent";
  specLock?: boolean;
} ): TaskStore {
  const { task } = opts;
  const store: Record<string, unknown> = {
    listTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn(async (id: string) => (id === task.id ? task : undefined)),
    getSettings: vi.fn().mockResolvedValue({ requirePlanApproval: false, ...opts.settings } as Settings),
    parseDependenciesFromPrompt: vi.fn().mockResolvedValue([]),
    parseStepsFromPrompt: vi.fn().mockResolvedValue([]),
    parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    updateTask: vi.fn(),
    /*
    Must actually invoke its callback and apply the patch. `updatePlanningStateIfStillCurrent`
    reports success from whether the callback ran, so a `vi.fn()` that ignores it makes EVERY
    finalize report "no longer in the planning stage" and return before the release — which
    silently turns every case below into the same uninteresting early exit.
    */
    updateTaskAtomic: vi.fn(async (_id: string, patch: unknown) => {
      const next = typeof patch === "function"
        ? (patch as (t: Task) => Partial<Task> | null)(task)
        : (patch as Partial<Task> | null);
      if (next) Object.assign(task, next);
      return task;
    }),
    moveTask: vi.fn(),
    withTaskLock: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()),
    readTaskForMove: vi.fn(async (id: string) => (id === task.id ? task : undefined)),
    logEntry: vi.fn(),
    recordActivity: vi.fn().mockResolvedValue(undefined),
    getTaskWorkflowSelection: vi.fn().mockReturnValue({ workflowId: "builtin:coding", stepIds: [] }),
    on: vi.fn(),
    off: vi.fn(),
  };
  if (opts.specLock) {
    store.isBackendMode = vi.fn(() => true);
    store.withPlanningLifecycleLock = vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn());
    store.captureCurrentPlanEvidence = vi.fn(async () => {
      throw new Error("planning lifecycle lock was reacquired");
    });
    store.captureCurrentPlanEvidenceWhilePlanningLocked = vi.fn().mockResolvedValue(undefined);
    store.lockCurrentPlanWhilePlanningLocked = vi.fn().mockResolvedValue(undefined);
    store.reconcileSpecDriftWhilePlanningLocked = vi.fn().mockResolvedValue(undefined);
  }
  if (opts.moveTaskIfResult !== "absent") {
    store.moveTaskIf = vi.fn(async (_id: string, column: string) => {
      if (opts.moveTaskIfResult === "refused") {
        // The planning-stage guard rejected the move; the card stays put (FN-8361).
        return { moved: false, task };
      }
      return { moved: true, task: { ...task, column, status: null } };
    });
  }
  return store as unknown as TaskStore;
}

describe("planning handoff outcome — recoverApprovedTask reports what finalize did", () => {
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "fusion-handoff-outcome-"));
    await mkdir(join(rootDir, ".fusion", "tasks", "FN-001"), { recursive: true });
    await writeFile(join(rootDir, ".fusion", "tasks", "FN-001", "PROMPT.md"), REAL_SPEC);
    vi.spyOn(planLog, "log").mockImplementation(() => {});
    vi.spyOn(planLog, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(rootDir, { recursive: true, force: true });
  });

  it("reports recovered when the card is actually released (the control)", async () => {
    const task = createTask();
    const store = createStore({ task, moveTaskIfResult: "moved" });

    const recovered = await new TriageProcessor(store, rootDir).recoverApprovedTask(task);

    expect(recovered).toBe(true);
    expect(store.moveTaskIf).toHaveBeenCalledWith("FN-001", "todo", expect.any(Function));
  });

  it("captures plan evidence without reacquiring the planning lifecycle lock", async () => {
    const task = createTask();
    const store = createStore({ task, moveTaskIfResult: "moved", specLock: true });

    await expect(new TriageProcessor(store, rootDir).recoverApprovedTask(task)).resolves.toBe(true);

    expect(store.captureCurrentPlanEvidenceWhilePlanningLocked).toHaveBeenCalledWith(
      "FN-001",
      expect.stringContaining("## Steps"),
    );
    expect(store.captureCurrentPlanEvidence).not.toHaveBeenCalled();
  });

  it("reports NOT recovered when the planning-stage guard refuses the release move (FN-8361)", async () => {
    // The symptom: `true` here makes handleStuckAbortRequeue stop, so the card
    // keeps a finished spec in the planner column with its retry budget skipped.
    const task = createTask();
    const store = createStore({ task, moveTaskIfResult: "refused" });

    const recovered = await new TriageProcessor(store, rootDir).recoverApprovedTask(task);

    expect(recovered).toBe(false);
  });

  it("reports NOT recovered when the store cannot perform the release move at all", async () => {
    const task = createTask();
    const store = createStore({ task, moveTaskIfResult: "absent" });

    const recovered = await new TriageProcessor(store, rootDir).recoverApprovedTask(task);

    expect(recovered).toBe(false);
  });

  it("STILL reports recovered when finalize parks the card for manual plan approval", async () => {
    /*
    Load-bearing control, not a courtesy case. A park is a successful recovery
    outcome: the card is where the operator's pending decision put it. If this
    returned false, handleStuckAbortRequeue would take its draft path and stamp
    `needs-replan` over a plan a human is mid-review on — a worse bug than the one
    the other two cases fix. Whoever narrows this to `outcome === "released"` will
    fail here.
    */
    const task = createTask();
    const store = createStore({
      task,
      settings: { requirePlanApproval: true, planApprovalMode: "workflow" } as Partial<Settings>,
      moveTaskIfResult: "moved",
    });

    const recovered = await new TriageProcessor(store, rootDir).recoverApprovedTask(task);

    expect(recovered).toBe(true);
    // Parked, so the release move must NOT have been attempted.
    expect(store.moveTaskIf).not.toHaveBeenCalled();
  });

  it("leaves the pre-existing withheld-before-finalize paths reporting false", async () => {
    // Recovery's own guards run BEFORE finalize and already returned false; the
    // outcome plumbing must not have changed them.
    const seedTask = createTask({ status: "needs-replan" });
    const store = createStore({ task: seedTask, moveTaskIfResult: "moved" });

    await expect(
      new TriageProcessor(store, rootDir).recoverApprovedTask(seedTask),
    ).resolves.toBe(false);
    expect(store.moveTaskIf).not.toHaveBeenCalled();
  });
});
