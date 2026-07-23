import { describe, it, expect } from "vitest";
import { upsertWorkflowStepResult, MAX_WORKFLOW_STEP_PRIOR_ATTEMPTS } from "../workflows/workflow-step-results.js";
import type { WorkflowStepResult } from "../types.js";

function makeResult(overrides: Partial<WorkflowStepResult> = {}): WorkflowStepResult {
  return {
    workflowStepId: "code-review",
    workflowStepName: "Code Review",
    status: "failed",
    ...overrides,
  };
}

describe("upsertWorkflowStepResult", () => {
  it("appends when the step id is absent", () => {
    const result = makeResult({ startedAt: "T1" });
    const next = upsertWorkflowStepResult(undefined, result);
    expect(next).toEqual([result]);
    expect(next).not.toBe(undefined);
  });

  it("replaces in place preserving array position", () => {
    const other = makeResult({ workflowStepId: "plan-review", startedAt: "T0" });
    const first = makeResult({ startedAt: "T1", output: "attempt-1" });
    const existing = [other, first];
    const second = makeResult({ startedAt: "T2", output: "attempt-2" });
    const next = upsertWorkflowStepResult(existing, second);
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual(other);
    expect(next[1].workflowStepId).toBe("code-review");
    expect(next[1].output).toBe("attempt-2");
  });

  it("snapshots a replaced failed entry into priorAttempts (Symptom Verification)", () => {
    const attempt1 = makeResult({ startedAt: "T1", output: "attempt-1 feedback", status: "failed" });
    const attempt2 = makeResult({ startedAt: "T2", output: "attempt-2 feedback", status: "failed" });
    const next = upsertWorkflowStepResult([attempt1], attempt2);
    expect(next).toHaveLength(1);
    expect(next[0].output).toBe("attempt-2 feedback");
    expect(next[0].priorAttempts).toHaveLength(1);
    expect(next[0].priorAttempts?.[0].output).toBe("attempt-1 feedback");
    expect(next[0].priorAttempts?.[0].status).toBe("failed");
    expect(next[0].priorAttempts?.[0].startedAt).toBe("T1");
  });

  it("snapshots a replaced advisory_failure entry", () => {
    const attempt1 = makeResult({ startedAt: "T1", status: "advisory_failure", output: "advisory-1" });
    const attempt2 = makeResult({ startedAt: "T2", status: "passed", output: "attempt-2" });
    const next = upsertWorkflowStepResult([attempt1], attempt2);
    expect(next[0].priorAttempts).toHaveLength(1);
    expect(next[0].priorAttempts?.[0].output).toBe("advisory-1");
  });

  it("does NOT snapshot when the replaced entry was passed/skipped/pending", () => {
    for (const status of ["passed", "skipped", "pending"] as const) {
      const attempt1 = makeResult({ startedAt: "T1", status, output: "attempt-1" });
      const attempt2 = makeResult({ startedAt: "T2", status: "failed", output: "attempt-2" });
      const next = upsertWorkflowStepResult([attempt1], attempt2);
      expect(next[0].priorAttempts ?? []).toHaveLength(0);
    }
  });

  it("dedupes a same-run pending -> failed transition of the same attempt (no phantom duplicate)", () => {
    const pending = makeResult({ startedAt: "T1", status: "pending" });
    const failed = makeResult({ startedAt: "T1", status: "failed", output: "final" });
    const next = upsertWorkflowStepResult([pending], failed);
    expect(next).toHaveLength(1);
    expect(next[0].priorAttempts ?? []).toHaveLength(0);
    expect(next[0].status).toBe("failed");
  });

  it("bounds priorAttempts to the cap across N successive failed re-runs, dropping oldest, newest-first", () => {
    let existing: WorkflowStepResult[] | undefined;
    const total = MAX_WORKFLOW_STEP_PRIOR_ATTEMPTS + 3;
    for (let i = 1; i <= total; i++) {
      existing = upsertWorkflowStepResult(existing, makeResult({ startedAt: `T${i}`, status: "failed", output: `attempt-${i}` }));
    }
    const finalEntry = existing?.[0];
    expect(finalEntry?.output).toBe(`attempt-${total}`);
    expect(finalEntry?.priorAttempts).toHaveLength(MAX_WORKFLOW_STEP_PRIOR_ATTEMPTS);
    // Newest-first: the most recently replaced attempt (total - 1) should be first.
    expect(finalEntry?.priorAttempts?.[0].output).toBe(`attempt-${total - 1}`);
    // Oldest attempts (1..(total - 1 - cap)) should have been dropped.
    const outputs = finalEntry?.priorAttempts?.map((r) => r.output) ?? [];
    expect(outputs).not.toContain("attempt-1");
  });

  it("respects a custom maxPriorAttempts option", () => {
    let existing: WorkflowStepResult[] | undefined;
    for (let i = 1; i <= 4; i++) {
      existing = upsertWorkflowStepResult(existing, makeResult({ startedAt: `T${i}`, status: "failed", output: `attempt-${i}` }), { maxPriorAttempts: 1 });
    }
    expect(existing?.[0].priorAttempts).toHaveLength(1);
    expect(existing?.[0].priorAttempts?.[0].output).toBe("attempt-3");
  });

  it("never mutates the input array or entries", () => {
    const attempt1 = makeResult({ startedAt: "T1", status: "failed", output: "attempt-1" });
    const existing = [attempt1];
    const existingCopy = JSON.parse(JSON.stringify(existing));
    const attempt2 = makeResult({ startedAt: "T2", status: "failed", output: "attempt-2" });
    const next = upsertWorkflowStepResult(existing, attempt2);
    expect(existing).toEqual(existingCopy);
    expect(next).not.toBe(existing);
  });

  it("strips nested priorAttempts from a snapshot to a single level", () => {
    const grandparent = makeResult({ startedAt: "T1", status: "failed", output: "gp" });
    let existing = upsertWorkflowStepResult(undefined, grandparent);
    const parent = makeResult({ startedAt: "T2", status: "failed", output: "parent" });
    existing = upsertWorkflowStepResult(existing, parent);
    expect(existing[0].priorAttempts).toHaveLength(1);

    const child = makeResult({ startedAt: "T3", status: "failed", output: "child" });
    existing = upsertWorkflowStepResult(existing, child);
    expect(existing[0].priorAttempts).toHaveLength(2);
    // Every snapshot in the history must itself be single-level (no nested priorAttempts).
    for (const snapshot of existing[0].priorAttempts ?? []) {
      expect(snapshot.priorAttempts).toBeUndefined();
    }
  });

  it("carries forward already-accumulated priorAttempts across a non-failure re-run", () => {
    const attempt1 = makeResult({ startedAt: "T1", status: "failed", output: "attempt-1" });
    let existing = upsertWorkflowStepResult(undefined, attempt1);
    const attempt2 = makeResult({ startedAt: "T2", status: "failed", output: "attempt-2" });
    existing = upsertWorkflowStepResult(existing, attempt2);
    expect(existing[0].priorAttempts).toHaveLength(1);

    // A later passing attempt should still carry forward the accumulated history,
    // plus snapshot the failed attempt-2 entry it replaced.
    const attempt3 = makeResult({ startedAt: "T3", status: "passed", output: "attempt-3" });
    existing = upsertWorkflowStepResult(existing, attempt3);
    expect(existing[0].status).toBe("passed");
    expect(existing[0].priorAttempts).toHaveLength(2);
    expect(existing[0].priorAttempts?.map((r) => r.output)).toEqual(["attempt-2", "attempt-1"]);
  });
});
