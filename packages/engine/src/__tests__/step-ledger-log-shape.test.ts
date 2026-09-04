import { describe, expect, it, vi } from "vitest";
import { evaluateStepLedgerSeal, type TaskDetail } from "@fusion/core";
import { recoverApprovedStepsOnResume } from "../executor/recover-approved-steps-on-resume.js";

const COMPLETION_MARKER = "Task marked done by agent";
const STEP_TRANSITION = /^Step \d+ \(.+\) → (in-progress|done|skipped)$/;

function assertNoPostCompletionTransition(actions: string[]) {
  let sealed = false;
  for (const action of actions) {
    if (action.includes(COMPLETION_MARKER)) sealed = true;
    if (action.includes("Executor using model:") || action.includes("Resumed agent session after unpause") || action.startsWith("Step ledger reopened")) {
      sealed = false;
    }
    if (sealed && STEP_TRANSITION.test(action)) {
      throw new Error(`step transition appeared after completion: ${action}`);
    }
  }
}

function taskForResume(log: TaskDetail["log"]): TaskDetail {
  return {
    id: "FN-255",
    title: "Ledger shape",
    description: "Keep pending entries parseable.",
    column: "in-progress",
    dependencies: [],
    steps: [{ name: "Preflight", status: "in-progress" }],
    currentStep: 0,
    log,
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  } as TaskDetail;
}

describe("step ledger log shape", () => {
  it("replays the monorepo and workspace shapes without duplicate or post-completion transitions", () => {
    const monorepo = [
      "Executor using model: openai/gpt-5.6",
      "Step 0 (Preflight) → in-progress",
      "Step 0 (Preflight) → done",
      COMPLETION_MARKER,
    ];
    const workspace = [
      "Step 0 (Preflight) → in-progress",
      "Step 0 (Preflight) → done",
      COMPLETION_MARKER,
    ];

    for (const actions of [monorepo, workspace]) {
      expect(actions.filter((action) => action === "Step 0 (Preflight) → in-progress")).toHaveLength(1);
      expect(actions.filter((action) => action === "Step 0 (Preflight) → done")).toHaveLength(1);
      expect(() => assertNoPostCompletionTransition(actions)).not.toThrow();
      expect(evaluateStepLedgerSeal(actions.map((action) => ({ action })))).toMatchObject({ sealed: true });
    }
  });

  it("keeps a pending reopen line byte-for-byte parseable and lets resume recovery find it", async () => {
    const log = [
      { timestamp: "2026-08-29T00:00:00.000Z", action: COMPLETION_MARKER },
      { timestamp: "2026-08-29T00:00:01.000Z", action: "Step ledger reopened — step 0 (Preflight) returned to pending after completion" },
      { timestamp: "2026-08-29T00:00:02.000Z", action: "Step 0 (Preflight) → pending" },
      { timestamp: "2026-08-29T00:00:03.000Z", action: "code review Step 0: APPROVE" },
    ];
    const task = taskForResume(log);
    const updateStep = vi.fn(async () => ({ ...task, steps: [{ ...task.steps[0]!, status: "done" as const }] }));
    const store = {
      getTask: vi.fn(async () => task),
      logEntry: vi.fn(async () => undefined),
      updateStep,
    };

    expect(log[2]?.action).toMatch(/^Step (\d+) \(.+\) → pending$/);
    await recoverApprovedStepsOnResume(store as never, task.id);

    expect(updateStep).toHaveBeenCalledWith(task.id, 0, "done");
    expect(evaluateStepLedgerSeal(log)).toEqual({ sealed: false });
  });
});
