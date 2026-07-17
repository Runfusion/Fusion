import { describe, expect, it } from "vitest";
import { evaluateNoCommitsNoOpFinalize, type TaskStep } from "../index.js";

function steps(statuses: Array<TaskStep["status"]>): TaskStep[] {
  return statuses.map((status, index) => ({ name: `Step ${index}`, status }));
}

function namedSteps(entries: Array<[string, TaskStep["status"]]>): TaskStep[] {
  return entries.map(([name, status]) => ({ name, status }));
}

describe("evaluateNoCommitsNoOpFinalize", () => {
  it("blocks the FN-6455 skipped-release shape", () => {
    const result = evaluateNoCommitsNoOpFinalize({
      noCommitsExpected: true,
      steps: steps(["done", "skipped", "skipped", "skipped", "skipped", "skipped"]),
    });

    expect(result).toMatchObject({ blocked: true, doneCount: 1, incompleteCount: 5 });
  });

  it("allows legitimate all-done no-op tasks", () => {
    expect(evaluateNoCommitsNoOpFinalize({
      noCommitsExpected: true,
      steps: steps(["done", "done", "done"]),
    })).toEqual({ blocked: false, doneCount: 3, incompleteCount: 0 });
  });

  it("allows mostly-done no-commits ops tasks with only a minor non-verification skipped tail", () => {
    expect(evaluateNoCommitsNoOpFinalize({
      noCommitsExpected: true,
      steps: namedSteps([
        ["Plan", "done"],
        ["Configure", "done"],
        ["Apply", "done"],
        ["Announce release", "done"],
        ["Update dashboard", "done"],
        ["Optional cleanup", "skipped"],
      ]),
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
    expect(evaluateNoCommitsNoOpFinalize({ noCommitsExpected: false, steps: [] }))
      .toEqual({ blocked: false, doneCount: 0, incompleteCount: 0 });
  });

  // FN-8141: the laundered shape — a commit-expected task whose branch is empty
  // because the work was reverted, with a majority of steps done and the
  // remainder skipped. Must block even though it is not `noCommitsExpected` and
  // done (3) > skipped (2).
  it("blocks the FN-8141 reverted commit-expected shape (3 done + 2 skipped)", () => {
    const result = evaluateNoCommitsNoOpFinalize({
      noCommitsExpected: false,
      steps: namedSteps([
        ["Update pi SDK", "done"],
        ["Wire runtime", "done"],
        ["Verify Kimi K3", "done"],
        ["Testing & Verification", "skipped"],
        ["Documentation & Delivery", "skipped"],
      ]),
    });

    expect(result).toMatchObject({ blocked: true, doneCount: 3, incompleteCount: 2 });
    expect(result.reason).toContain("Testing & Verification");
  });

  it("blocks a skipped verification step regardless of done/skip ratio or noCommitsExpected", () => {
    // Majority done, only one skipped step, but it is verification-flavored.
    for (const noCommitsExpected of [true, false]) {
      const result = evaluateNoCommitsNoOpFinalize({
        noCommitsExpected,
        steps: namedSteps([
          ["Implement", "done"],
          ["Refactor", "done"],
          ["Docs", "done"],
          ["QA sign-off", "skipped"],
        ]),
      });
      expect(result).toMatchObject({ blocked: true });
      expect(result.reason).toContain("QA sign-off");
    }
  });

  it("blocks any non-verification skipped step on a commit-expected task", () => {
    const result = evaluateNoCommitsNoOpFinalize({
      noCommitsExpected: false,
      steps: namedSteps([
        ["Implement", "done"],
        ["Deploy notes", "skipped"],
      ]),
    });
    expect(result).toMatchObject({ blocked: true, doneCount: 1, incompleteCount: 1 });
    expect(result.reason).toContain("Deploy notes");
  });

  it("does not block skip-free ordinary tasks (all-done handled by lineage proof)", () => {
    expect(evaluateNoCommitsNoOpFinalize({
      noCommitsExpected: false,
      steps: steps(["done", "done"]),
    })).toEqual({ blocked: false, doneCount: 2, incompleteCount: 0 });
    // No skipped step and not noCommitsExpected → out of this guard's scope.
    expect(evaluateNoCommitsNoOpFinalize({
      steps: steps(["pending"]),
    })).toEqual({ blocked: false, doneCount: 0, incompleteCount: 1 });
  });
});
