import "./executor-test-helpers.js";
import { describe, expect, it } from "vitest";
import { evaluateStepLedgerSeal } from "@fusion/core";
import type { Task } from "@fusion/core";
import { appendRemediationStepsImpl } from "../../../core/src/task-store/remediation-step-ops.js";
import { appendReviewRemediationSteps } from "../executor/append-review-remediation-steps.js";

/*
FNXC:StepLedgerIntegrity 2026-09-01-00:45:
Guards the branch Code Review ACTUALLY takes.

`appendReviewRemediationSteps` publishes the remediation work, keyed attempt, aggregate charge,
and step-ledger reopening in one fenced mutation. Code Review previously took a separate inline
branch whose missing reopen stamp left the new Fix step permanently sealed after completion.
*/

const DONE_MARKER = "Task marked done by agent";

function completedTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-270",
    title: "Keep visited dashboard views mounted",
    description: "Remediation after completion.",
    column: "in-progress",
    status: null,
    error: null,
    dependencies: [],
    steps: [
      { name: "Preflight", status: "done" },
      { name: "Implement", status: "done" },
      { name: "Testing & Verification", status: "done" },
    ],
    currentStep: 3,
    prompt: "# Task FN-270\n\n## File Scope\n- packages/dashboard/app/components/Board.tsx\n",
    worktree: "/tmp/fusion/fn-270",
    postReviewFixCount: 0,
    workflowStepResults: [{
      workflowStepId: "code-review",
      workflowStepName: "Code Review",
      phase: "pre-merge",
      status: "failed",
      verdict: "REVISE",
      startedAt: "2026-08-31T23:01:30.000Z",
      completedAt: "2026-08-31T23:02:00.000Z",
    }],
    log: [
      { timestamp: "2026-08-31T23:00:00.000Z", action: "Step 2 (Testing & Verification) → done" },
      { timestamp: "2026-08-31T23:01:00.000Z", action: DONE_MARKER },
    ],
    createdAt: "2026-08-30T18:00:00.000Z",
    updatedAt: "2026-08-31T23:01:00.000Z",
    ...overrides,
  } as unknown as Task;
}

const REVISE_INFO = {
  nodeId: "code-review",
  stepName: "Code Review",
  phase: "pre-merge" as const,
  status: "failed" as const,
  verdict: "REVISE",
  reviewKind: "code" as const,
  feedback: "Hidden views still portal workflow controls before effects run.",
  findings: [{
    id: "chat-host-census",
    title: "Chat host census still uses cwd-relative filesystem traversal",
    body: "Resolve the host census from the module path instead of the process cwd.",
    filePath: "packages/dashboard/app/components/__tests__/ChatView.pop-out-host-inventory.test.tsx",
    line: 12,
    severity: "critical",
    resolution: "open",
  }],
};

/** Store fake carrying the writers this path uses, with the atomic apply the real store performs. */
function makeDeps(initial: Task) {
  let live = initial;
  const store = {
    getTask: async () => live,
    updateTask: async (_id: string, patch: Record<string, unknown>) => {
      live = { ...live, ...patch } as Task;
      return live;
    },
    updateTaskAtomic: async (_id: string, compute: (t: Task) => Record<string, unknown> | null) => {
      const patch = compute(live);
      if (patch) live = { ...live, ...patch } as Task;
      return live;
    },
    /* Delegate to the REAL writer: a hand-rolled append would not exercise its ledger handling. */
    appendRemediationSteps: async (id: string, steps: readonly unknown[], options: { wave?: number } = {}) =>
      appendRemediationStepsImpl(store as never, id, steps as never, options),
    logEntry: async () => undefined,
    addTaskComment: async () => undefined,
  };
  const deps = {
    store,
    readTaskArtifact: async () => live.prompt ?? "",
    getRunContextFor: () => undefined,
    sendTaskBackForFix: async () => undefined,
  };
  return { deps: deps as never, current: () => live };
}

describe("Code Review remediation reopens the step ledger on the path it takes", () => {
  it("clears the completion seal in the accounted Code Review transaction", async () => {
    const { deps, current } = makeDeps(completedTask());
    expect(evaluateStepLedgerSeal(current().log).sealed).toBe(true);

    const outcome = await appendReviewRemediationSteps(deps, current(), REVISE_INFO as never, {
      attemptClaim: { revisionKey: "code-review", stepName: "Code Review", status: "failed", maxRevisions: "unbounded" },
    } as never);

    expect(outcome).toBe("appended");
    expect((current().steps ?? []).some((s) => /^Fix:/i.test(String(s.name ?? "")))).toBe(true);
    /* The contract every step transition consults: the new work must be startable. */
    expect(evaluateStepLedgerSeal(current().log).sealed).toBe(false);
  });

  /*
  The stamp answers a real seal only. Forging one for a card that never completed would make the
  marker meaningless and silently widen what counts as reopening implementation.
  */
  it("does not stamp a reopening when implementation never completed", async () => {
    const running = completedTask({
      log: [{ timestamp: "2026-08-31T23:00:00.000Z", action: "Executor using model: test/model" }],
    } as Partial<Task>);
    const { deps, current } = makeDeps(running);
    expect(evaluateStepLedgerSeal(current().log).sealed).toBe(false);

    await appendReviewRemediationSteps(deps, current(), REVISE_INFO as never, {
      attemptClaim: { revisionKey: "code-review", stepName: "Code Review", status: "failed", maxRevisions: "unbounded" },
    } as never);

    const actions = (current().log ?? []).map((e) => e.action);
    expect(actions.some((a) => a.startsWith("Step ledger reopened"))).toBe(false);
  });
});
