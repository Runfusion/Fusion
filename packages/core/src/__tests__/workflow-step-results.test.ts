import { describe, it, expect } from "vitest";
import { applySupersededFindingIds, MAX_WORKFLOW_REVIEW_FINDINGS, MAX_WORKFLOW_STEP_PRIOR_ATTEMPTS, normalizeSupersededFindingIds, normalizeWorkflowReviewFindings, upsertWorkflowStepResult } from "../workflows/workflow-step-results.js";
import type { WorkflowStepResult } from "../types.js";

function makeResult(overrides: Partial<WorkflowStepResult> = {}): WorkflowStepResult {
  return {
    workflowStepId: "code-review",
    workflowStepName: "Code Review",
    status: "failed",
    ...overrides,
  };
}

describe("normalizeWorkflowReviewFindings", () => {
  it("normalizes bounded populated findings with stable collision-free ids", () => {
    expect(normalizeWorkflowReviewFindings([
      { id: " issue ", title: " Title ", body: " Body ", filePath: " src/a.ts ", line: 4.8, severity: "high" },
      { id: "issue", title: "Second", body: "Action", line: -1, severity: "unknown" },
    ])).toEqual([
      { id: "issue", title: "Title", body: "Body", filePath: "src/a.ts", line: 4, severity: "high" },
      { id: "issue-2", title: "Second", body: "Action" },
    ]);
  });

  it("drops malformed, empty, and oversized entries without fabricating findings", () => {
    expect(normalizeWorkflowReviewFindings([
      null,
      { title: "", body: "body" },
      { title: "title", body: "" },
      { title: "x".repeat(241), body: "body" },
      { title: "title", body: "x".repeat(4001) },
    ])).toBeUndefined();
  });

  it("preserves valid non-open resolutions but normalizes open and invalid values away", () => {
    expect(normalizeWorkflowReviewFindings([
      { id: "receipt", title: "Receipt", body: "Fixed", resolution: "resolved-in-review" },
      { id: "stale", title: "Stale", body: "Fixed elsewhere", resolution: "superseded" },
      { id: "open", title: "Open", body: "Fix", resolution: "open" },
      { id: "invalid", title: "Invalid", body: "Still valid", resolution: "fixed" },
      { id: "null", title: "Null", body: "Still valid", resolution: null },
    ])).toEqual([
      { id: "receipt", title: "Receipt", body: "Fixed", resolution: "resolved-in-review" },
      { id: "stale", title: "Stale", body: "Fixed elsewhere", resolution: "superseded" },
      { id: "open", title: "Open", body: "Fix" },
      { id: "invalid", title: "Invalid", body: "Still valid" },
      { id: "null", title: "Null", body: "Still valid" },
    ]);
  });
});

describe("superseded finding claims", () => {
  it("normalizes bounded, deduplicated string ids", () => {
    expect(normalizeSupersededFindingIds([" c1 ", 4, "c1", "", "c2"])).toEqual(["c1", "c2"]);
    expect(normalizeSupersededFindingIds(Array.from({ length: MAX_WORKFLOW_REVIEW_FINDINGS + 1 }, (_, index) => `f${index}`))).toHaveLength(MAX_WORKFLOW_REVIEW_FINDINGS);
    expect(normalizeSupersededFindingIds({})).toBeUndefined();
  });

  it("stamps only unresolved findings outside the claiming result", () => {
    const prior = makeResult({ workflowStepId: "cleanup", findings: [
      { id: "c1", title: "Open", body: "Fix" },
      { id: "receipt", title: "Receipt", body: "Fixed", resolution: "resolved-in-review" },
    ], priorAttempts: [{ ...makeResult({ workflowStepId: "cleanup", findings: [{ id: "c1", title: "Old", body: "Old" }] }) }] });
    const claimant = makeResult({ workflowStepId: "code", findings: [{ id: "c1", title: "Own", body: "Own" }] });
    const next = applySupersededFindingIds([prior, claimant], ["c1", "receipt"], { excludeWorkflowStepId: "code", sourceWorkflowStepId: "cleanup" });
    expect(next?.[0].findings).toEqual([
      { id: "c1", title: "Open", body: "Fix", resolution: "superseded" },
      { id: "receipt", title: "Receipt", body: "Fixed", resolution: "resolved-in-review" },
    ]);
    const unrelated = makeResult({ workflowStepId: "other-review", findings: [{ id: "c1", title: "Different lane", body: "Must remain open" }] });
    const scoped = applySupersededFindingIds([prior, unrelated, claimant], ["c1"], { excludeWorkflowStepId: "code", sourceWorkflowStepId: "cleanup" });
    expect(scoped?.[1].findings?.[0]).not.toHaveProperty("resolution");
    expect(next?.[0].priorAttempts).toEqual(prior.priorAttempts);
    expect(next?.[1]).toBe(claimant);
    expect(applySupersededFindingIds(next, ["missing"], { excludeWorkflowStepId: "code", sourceWorkflowStepId: "cleanup" })).toBe(next);
  });
});

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

  it("keeps replaced findings in read-only history while new findings remain current", () => {
    const attempt1 = makeResult({ startedAt: "T1", findings: [{ id: "old", title: "Old", body: "Old body" }] });
    const attempt2 = makeResult({ startedAt: "T2", findings: [{ id: "new", title: "New", body: "New body" }] });
    const next = upsertWorkflowStepResult([attempt1], attempt2);
    expect(next[0].findings?.map((finding) => finding.id)).toEqual(["new"]);
    expect(next[0].priorAttempts?.[0].findings?.map((finding) => finding.id)).toEqual(["old"]);
  });

  it("snapshots a replaced advisory_failure entry", () => {
    const attempt1 = makeResult({ startedAt: "T1", status: "advisory_failure", output: "advisory-1" });
    const attempt2 = makeResult({ startedAt: "T2", status: "passed", output: "attempt-2" });
    const next = upsertWorkflowStepResult([attempt1], attempt2);
    expect(next[0].priorAttempts).toHaveLength(1);
    expect(next[0].priorAttempts?.[0].output).toBe("advisory-1");
  });

  it("preserves superseded Plan Review evidence when the new planning episode starts", () => {
    const oldPass = makeResult({
      workflowStepId: "plan-review",
      workflowStepName: "Plan Review",
      startedAt: "T1",
      status: "passed",
      supersededAt: "T2",
      supersededReason: "dependency-change",
    });
    const nextEpisode = makeResult({
      workflowStepId: "plan-review",
      workflowStepName: "Plan Review",
      startedAt: "T3",
      status: "pending",
    });

    const next = upsertWorkflowStepResult([oldPass], nextEpisode);

    expect(next[0].status).toBe("pending");
    expect(next[0].priorAttempts).toEqual([oldPass]);
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
