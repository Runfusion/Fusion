import { describe, expect, it } from "vitest";
import { evaluateNoCommitsNoOpFinalize, type TaskStep } from "../index.js";

function steps(statuses: Array<TaskStep["status"]>): TaskStep[] {
  return statuses.map((status, index) => ({ name: `Step ${index}`, status }));
}

describe("evaluateNoCommitsNoOpFinalize", () => {
  it("blocks the FN-6455 skipped-release shape", () => {
    const result = evaluateNoCommitsNoOpFinalize({
      noCommitsExpected: true,
      steps: steps(["done", "skipped", "skipped", "skipped", "skipped", "skipped"]),
    });

    expect(result).toMatchObject({ blocked: true, doneCount: 1, incompleteCount: 5 });
    expect(result.reason).toContain("done=1, incomplete=5");
  });

  it("allows legitimate all-done no-op tasks", () => {
    expect(evaluateNoCommitsNoOpFinalize({
      noCommitsExpected: true,
      steps: steps(["done", "done", "done"]),
    })).toEqual({ blocked: false, doneCount: 3, incompleteCount: 0 });
  });

  it("allows mostly-done no-op tasks with only a minor skipped tail", () => {
    expect(evaluateNoCommitsNoOpFinalize({
      noCommitsExpected: true,
      steps: steps(["done", "done", "done", "done", "done", "skipped"]),
    })).toEqual({ blocked: false, doneCount: 5, incompleteCount: 1 });
  });

  it("blocks pending or in-progress work on no-commits tasks", () => {
    expect(evaluateNoCommitsNoOpFinalize({
      noCommitsExpected: true,
      steps: steps(["done", "pending"]),
    })).toMatchObject({ blocked: true, doneCount: 1, incompleteCount: 1 });
    expect(evaluateNoCommitsNoOpFinalize({
      noCommitsExpected: true,
      steps: steps(["in-progress"]),
    })).toMatchObject({ blocked: true, doneCount: 0, incompleteCount: 1 });
  });

  it("preserves zero-step behavior", () => {
    expect(evaluateNoCommitsNoOpFinalize({ noCommitsExpected: true, steps: [] }))
      .toEqual({ blocked: false, doneCount: 0, incompleteCount: 0 });
  });

  it("does not block ordinary tasks", () => {
    expect(evaluateNoCommitsNoOpFinalize({
      noCommitsExpected: false,
      steps: steps(["done", "skipped", "skipped"]),
    })).toEqual({ blocked: false, doneCount: 1, incompleteCount: 2 });
    expect(evaluateNoCommitsNoOpFinalize({
      steps: steps(["pending"]),
    })).toEqual({ blocked: false, doneCount: 0, incompleteCount: 1 });
  });
});
