import "./executor-test-helpers.js";
import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";
import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";

/*
FNXC:ReviewRemediation 2026-08-31-07:58:
THE invariant: `requestPreMergeOptionalStepFix` returning `false` must never leave the card without
an explanation. The function has 34 refusal exits and roughly half write nothing, so a blocking
review could stop a card dead with an empty timeline -- indistinguishable from a hung engine.

Measured: FN-270 and FN-273 held a real REVISE with critical findings and produced no fix steps and
no timeline entry. Three diagnostic passes went into deducing WHICH exit had fired, because the code
would not say. This suite makes that class of silence a test failure instead of an investigation.

Deliberately asserted at the OUTER seam rather than per exit: guarding sites one at a time is the
churn that keeps missing the next one, which is the same lesson `fenceStoreForClaim` records. Any
future exit, however it is written, is covered by construction.
*/

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-273",
    title: "A blocking review must never stop a card silently",
    description: "Remediation decline visibility.",
    column: "in-review",
    status: null,
    dependencies: [],
    steps: [{ name: "Implement", status: "done" }],
    currentStep: 0,
    log: [],
    worktree: "/tmp/fusion/fn-273",
    postReviewFixCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function harness() {
  resetExecutorMocks();
  const store = createMockStore();
  let live = task();
  store.getTask.mockResolvedValue(live);
  /* The shared fake omits `updateTaskAtomic`, which the real TaskStore provides and the appender requires. */
  (store as unknown as { updateTaskAtomic: unknown }).updateTaskAtomic =
    async (_id: string, compute: (current: Task) => Record<string, unknown> | null) => {
      const patch = compute(live);
      if (patch) live = { ...live, ...patch } as Task;
      return live;
    };
  store.getSettings.mockResolvedValue({
    maxConcurrent: 2, maxWorktrees: 4, pollIntervalMs: 15_000,
    autoMerge: true, maxAutoMergeRetries: 3,
  });
  const executor = new TaskExecutor(store as never, "/tmp/test");
  const request = (info: Record<string, unknown>) =>
    (executor as never as {
      requestPreMergeOptionalStepFix(id: string, t: Task, i: Record<string, unknown>): Promise<boolean>;
    }).requestPreMergeOptionalStepFix(live.id, live, info);
  const writes = () => store.logEntry.mock.calls.map((c: unknown[]) => String(c[1]));
  return { store, live, request, writes };
}

describe("a remediation decline is never silent", () => {
  /*
  Each row reaches a DIFFERENT early exit that writes nothing of its own. They are the cheap proof;
  the outer seam covers the rest of the 34 by construction.
  */
  it.each([
    ["wrong phase", { stepName: "Code Review", phase: "post-merge", status: "failed", verdict: "REVISE", feedback: "x" }],
    ["non-blocking status", { stepName: "Code Review", phase: "pre-merge", status: "passed", verdict: "REVISE", feedback: "x" }],
  ])("explains itself when declining on %s", async (_case, info) => {
    const { request, writes } = harness();

    await expect(request(info)).resolves.toBe(false);

    expect(writes().join("\n")).toContain("declined without explanation");
  });

  it("names the gate and the reviewer verdict so the decline is actionable", async () => {
    const { store, request } = harness();

    await request({
      nodeId: "code-review",
      stepName: "Code Review",
      phase: "post-merge",
      status: "failed",
      verdict: "REVISE",
      feedback: "x",
      findings: [{ id: "f1", severity: "critical", title: "t", body: "b" }],
    });

    const call = store.logEntry.mock.calls.find((c: unknown[]) => String(c[1]).includes("declined without explanation"));
    expect(call).toBeDefined();
    expect(String(call![1])).toContain("code-review");
    const detail = String(call![2] ?? "");
    expect(detail).toContain("REVISE");
    expect(detail).toContain("Findings: 1");
  });

  /*
  Control: a refusal that ALREADY narrates must not be double-reported. Without this the fix would
  bury the honest, specific refusals under a generic second line -- trading silence for noise.
  */
  it("stays quiet when the refusal already explained itself", async () => {
    const { store, request } = harness();

    // A zero revision budget is a refusal that narrates its own reason.
    await expect(request({
      nodeId: "code-review", stepName: "Code Review", phase: "pre-merge",
      status: "failed", verdict: "REVISE", feedback: "x", maxRevisions: 0,
    })).resolves.toBe(false);

    const messages = store.logEntry.mock.calls.map((c: unknown[]) => String(c[1]));
    expect(messages.some((m) => m.includes("budget exhausted"))).toBe(true);
    expect(messages.some((m) => m.includes("declined without explanation"))).toBe(false);
  });
});
