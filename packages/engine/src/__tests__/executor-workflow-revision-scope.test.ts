import { describe, expect, it } from "vitest";
import {
  extractReferencedPathsFromWorkflowFeedback,
  partitionWorkflowRevisionFeedback,
  workflowPathMatchesDeclaredScope,
} from "../executor.js";

describe("workflow revision scope partitioning", () => {
  const declaredScope = [
    "packages/engine/src/executor.ts",
    "packages/engine/src/__tests__/*",
  ];

  it("keeps fully in-scope feedback attached to the original task", () => {
    const feedback = [
      "Update `packages/engine/src/executor.ts` to guard the rerun path.",
      "Add a regression in `packages/engine/src/__tests__/executor-step-session.test.ts`.",
    ].join("\n\n");

    const result = partitionWorkflowRevisionFeedback(feedback, declaredScope);

    expect(result.inScopeFeedback).toBe(feedback);
    expect(result.outOfScopeFeedback).toBe("");
    expect(result.outOfScopeSegments).toEqual([]);
  });

  it("forks fully out-of-scope feedback into a follow-up block", () => {
    const feedback = [
      "Move the setting into `packages/core/src/types.ts`.",
      "Document it in `docs/settings-reference.md`.",
    ].join("\n\n");

    const result = partitionWorkflowRevisionFeedback(feedback, declaredScope);

    expect(result.inScopeFeedback).toBe("");
    expect(result.outOfScopeFeedback).toBe(feedback);
    expect(result.outOfScopeSegments).toHaveLength(2);
  });

  it("splits mixed feedback by paragraph and preserves pathless guidance with the original task", () => {
    const feedback = [
      "Tighten the executor behavior in `packages/engine/src/executor.ts`.",
      "Keep the rerun log message concise.",
      "Add the new opt-out setting in `packages/core/src/settings-schema.ts`.",
    ].join("\n\n");

    const result = partitionWorkflowRevisionFeedback(feedback, declaredScope);

    expect(result.inScopeSegments).toEqual([
      "Tighten the executor behavior in `packages/engine/src/executor.ts`.",
      "Keep the rerun log message concise.",
    ]);
    expect(result.outOfScopeSegments).toEqual([
      "Add the new opt-out setting in `packages/core/src/settings-schema.ts`.",
    ]);
  });

  it("keeps feedback with no detectable file paths on the original task", () => {
    const feedback = "Clarify the retry behavior and keep the reviewer-facing explanation actionable.";

    const result = partitionWorkflowRevisionFeedback(feedback, declaredScope);

    expect(result.detectedPaths).toEqual([]);
    expect(result.inScopeFeedback).toBe(feedback);
    expect(result.outOfScopeFeedback).toBe("");
  });

  it("normalizes feedback paths before comparing them to declared scope", () => {
    expect(workflowPathMatchesDeclaredScope("./packages/engine/src/__tests__/executor-step-session.test.ts", declaredScope)).toBe(true);
    expect(workflowPathMatchesDeclaredScope("packages/core/src/types.ts", declaredScope)).toBe(false);
  });

  it("extracts backticked and bare project-relative paths", () => {
    const feedback = "Touch `packages/engine/src/executor.ts`, then mirror the test in packages/engine/src/__tests__/executor-step-session.test.ts.";

    expect(extractReferencedPathsFromWorkflowFeedback(feedback)).toEqual([
      "packages/engine/src/executor.ts",
      "packages/engine/src/__tests__/executor-step-session.test.ts",
    ]);
  });
});
