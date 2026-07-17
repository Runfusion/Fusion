import { describe, expect, it } from "vitest";
import { evaluateSkipBypassTaint, type TaskStep } from "../index.js";

/*
FNXC:Lifecycle 2026-07-16-21:40:
FN-8141 — the skip-bypass taint evaluator is the single rule every AUTO-promotion
check consults. These tests assert the general invariant across the enumerated
inputs (skip before vs after refusal, taint-clearing, PREMISE-STALE unaffected),
not just the exact FN-8141 shape.
*/
function steps(statuses: Array<TaskStep["status"]>): TaskStep[] {
  return statuses.map((status, index) => ({ name: `Step ${index}`, status }));
}

describe("evaluateSkipBypassTaint", () => {
  it("does NOT block skips when no refusal marker is set (skip-before-refusal counts)", () => {
    const result = evaluateSkipBypassTaint({
      steps: steps(["done", "done", "skipped", "skipped"]),
      bulkCompletionRefusalAt: undefined,
    });
    expect(result).toEqual({ blocked: false, tainted: false, skippedStepCount: 2 });
  });

  it("blocks the FN-8141 shape: skips present AND refusal marker active (skip-after-refusal)", () => {
    const result = evaluateSkipBypassTaint({
      steps: steps(["done", "done", "done", "skipped", "skipped"]),
      bulkCompletionRefusalAt: "2026-07-16T21:40:00.000Z",
    });
    expect(result.blocked).toBe(true);
    expect(result.tainted).toBe(true);
    expect(result.skippedStepCount).toBe(2);
    expect(result.reason).toContain("skipped after a bulk-step-completion refusal");
  });

  it("does NOT block a tainted task once its skipped steps are genuinely re-done (no skipped left)", () => {
    // A fresh lifecycle that legitimately completes the work leaves zero skipped
    // steps, so even a lingering marker cannot block — real work is never laundering.
    const result = evaluateSkipBypassTaint({
      steps: steps(["done", "done", "done", "done", "done"]),
      bulkCompletionRefusalAt: "2026-07-16T21:40:00.000Z",
    });
    expect(result).toEqual({ blocked: false, tainted: true, skippedStepCount: 0 });
  });

  it("clears (does not block) when the marker is cleared, even with skipped steps present", () => {
    // Simulates an accepted fn_task_done / operator retry that set the marker to null.
    const result = evaluateSkipBypassTaint({
      steps: steps(["done", "skipped", "skipped"]),
      bulkCompletionRefusalAt: undefined,
    });
    expect(result.blocked).toBe(false);
    expect(result.tainted).toBe(false);
  });

  it("PREMISE STALE accepted-done shape is unaffected: an empty-marker skip-heavy task promotes", () => {
    // PREMISE STALE skips remaining steps then calls fn_task_done which is ACCEPTED
    // and clears the marker, so the guard never sees a tainted skip-heavy task.
    const result = evaluateSkipBypassTaint({
      steps: steps(["done", "skipped", "skipped", "skipped"]),
      bulkCompletionRefusalAt: undefined,
    });
    expect(result.blocked).toBe(false);
  });

  it("handles empty / missing steps without blocking", () => {
    expect(evaluateSkipBypassTaint({ steps: [], bulkCompletionRefusalAt: "2026-07-16T21:40:00.000Z" }))
      .toEqual({ blocked: false, tainted: true, skippedStepCount: 0 });
    expect(evaluateSkipBypassTaint({ steps: undefined as unknown as TaskStep[], bulkCompletionRefusalAt: undefined }))
      .toEqual({ blocked: false, tainted: false, skippedStepCount: 0 });
  });

  it("treats an empty-string marker as no taint (null-equivalent)", () => {
    expect(evaluateSkipBypassTaint({ steps: steps(["done", "skipped"]), bulkCompletionRefusalAt: "" }))
      .toEqual({ blocked: false, tainted: false, skippedStepCount: 1 });
  });
});
