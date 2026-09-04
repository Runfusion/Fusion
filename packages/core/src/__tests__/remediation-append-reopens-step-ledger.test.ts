import { describe, expect, it } from "vitest";
import type { Task, TaskStep } from "../types.js";
import { appendRemediationStepsImpl } from "../task-store/remediation-step-ops.js";
import { evaluateStepLedgerSeal, STEP_LEDGER_REOPEN_MARKER_PREFIX } from "../task-store/step-ledger-seal.js";

/*
FNXC:StepLedgerIntegrity 2026-08-31-09:44:
Remediation appended after a clean completion must REOPEN the step ledger, or the work it just
created cannot run.

The completion seal refuses any step transition once the log tail carries a marker like "Task marked
done by agent". Its re-entry markers are a fresh executor session, a resume-after-unpause, and the
reopen stamp -- and `updateStep` wrote that stamp only for a step returned to `pending` or an
operator edit. Remediation arrives through the APPEND path, which wrote nothing, so the seal
survived it.

Measured on FN-270: the card was correctly moved back for repair -- "Review gate Code Review
requested named remediation - moved back to in-progress" -- and the graph's next act, taking the new
Fix step to `in-progress`, was refused as a post-completion projection. Fix steps existed, the card
was in the right lane, and the work still could not start.

Asserted through the seal evaluator rather than a log-text match: the contract is "implementation is
reopened", and the evaluator is what every step transition actually consults.
*/

function completedTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-270",
    title: "Keep visited dashboard views mounted",
    description: "Remediation after completion.",
    column: "in-progress",
    status: null,
    dependencies: [],
    steps: [
      { name: "Preflight", status: "done" },
      { name: "Implement", status: "done" },
      { name: "Testing & Verification", status: "done" },
    ],
    currentStep: 3,
    log: [
      { timestamp: "2026-08-31T09:00:00.000Z", action: "Step 2 (Testing & Verification) → done" },
      { timestamp: "2026-08-31T09:01:00.000Z", action: "Task marked done by agent" },
    ],
    createdAt: "2026-08-30T18:00:00.000Z",
    updatedAt: "2026-08-31T09:01:00.000Z",
    ...overrides,
  } as unknown as Task;
}

function fixStep(detail = "Inactive retained views still portal workflow controls"): TaskStep {
  return {
    name: `Fix: ${detail}`,
    status: "pending",
    remediation: {
      wave: 1,
      gate: "Code Review",
      gateStepId: "code-review",
      detail,
      filePath: "packages/dashboard/app/components/Board.tsx",
    },
  } as unknown as TaskStep;
}

/** Minimal atomic store: applies the computed patch, exactly as the real writer does. */
function atomicStore(initial: Task) {
  let live = initial;
  return {
    current: () => live,
    store: {
      updateTaskAtomic: async (_id: string, compute: (t: Task) => Partial<Task> | null) => {
        const patch = compute(live);
        if (patch) live = { ...live, ...patch } as Task;
        return live;
      },
    } as never,
  };
}

describe("remediation appended after completion reopens the step ledger", () => {
  it("clears the completion seal so the new Fix step can start", async () => {
    const { store, current } = atomicStore(completedTask());
    expect(evaluateStepLedgerSeal(current().log).sealed).toBe(true);

    const result = await appendRemediationStepsImpl(store, "FN-270", [fixStep()]);

    expect(result.appendedCount).toBe(1);
    /* The contract every step transition consults -- not the wording of a log line. */
    expect(evaluateStepLedgerSeal(current().log).sealed).toBe(false);
  });

  it("records why implementation reopened", async () => {
    const { store, current } = atomicStore(completedTask());

    await appendRemediationStepsImpl(store, "FN-270", [fixStep()]);

    const actions = (current().log ?? []).map((e) => e.action);
    expect(actions.some((a) => a.startsWith(STEP_LEDGER_REOPEN_MARKER_PREFIX))).toBe(true);
    /* The prior completion is history, not erased: the timeline must still show both. */
    expect(actions).toContain("Task marked done by agent");
  });

  /*
  The stamp is only correct as a response to a real seal. Writing it on every append would forge a
  reopening for a card that never completed, and the marker would stop meaning anything.
  */
  it("does not stamp a reopening when implementation never completed", async () => {
    const running = completedTask({
      log: [{ timestamp: "2026-08-31T09:00:00.000Z", action: "Executor using model: test/model" }],
    });
    const { store, current } = atomicStore(running);
    expect(evaluateStepLedgerSeal(running.log).sealed).toBe(false);

    await appendRemediationStepsImpl(store, "FN-270", [fixStep()]);

    const actions = (current().log ?? []).map((e) => e.action);
    expect(actions.some((a) => a.startsWith(STEP_LEDGER_REOPEN_MARKER_PREFIX))).toBe(false);
  });

  it("leaves the ledger untouched when the append is a no-op", async () => {
    const { store, current } = atomicStore(completedTask());
    const before = (current().log ?? []).length;

    /* No `remediation` payload — nothing is appended, so nothing is reopened. */
    const result = await appendRemediationStepsImpl(store, "FN-270", [{ name: "Fix: bare", status: "pending" } as TaskStep]);

    expect(result.appendedCount).toBe(0);
    expect((current().log ?? []).length).toBe(before);
    expect(evaluateStepLedgerSeal(current().log).sealed).toBe(true);
  });
});
