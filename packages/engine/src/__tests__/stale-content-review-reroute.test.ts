import { beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({
  resolveWorkflowIrForTask: vi.fn(),
  computeWorkflowIrPin: vi.fn(() => ({ irHash: "ir-hash" })),
}));
vi.mock("@fusion/core", () => core);

import { rerouteSingularStaleContentToReview } from "../merge/stale-content-review-reroute.js";

const currentFingerprint = "current-diff";
const task = (overrides: Record<string, unknown> = {}) => ({
  id: "FN-9234",
  column: "in-review",
  autoMerge: true,
  workflowStepResults: [{ workflowStepId: "security-review", reviewInputFingerprint: "old-diff" }],
  ...overrides,
}) as any;
const singular = { kind: "singular", diff: { state: "fingerprint", fingerprint: currentFingerprint } } as any;

function store(seeded = true) {
  return {
    getTaskWorkflowSelection: vi.fn(() => ({ stepIds: ["security-review", "code-review"] })),
    listWorkflowWorkItemsForTask: vi.fn(async () => []),
    seedWorkspaceCodeReviewContinuationIfIdle: vi.fn(async () => ({ seeded })),
  } as any;
}

beforeEach(() => {
  core.resolveWorkflowIrForTask.mockResolvedValue({
    name: "Review",
    nodes: [
      { id: "security-review", kind: "step-review", column: "in-review", config: { name: "Code Review", reviewKind: "code", defaultOn: true } },
      { id: "code-review", kind: "step-review", column: "in-review", config: { name: "Code Review", reviewKind: "code", defaultOn: true } },
    ],
  });
});

describe("singular stale-content review reroute", () => {
  it("seeds the earliest required stale lane without changing review evidence", async () => {
    const subject = task();
    const subjectBefore = structuredClone(subject);
    const fake = store();
    await expect(rerouteSingularStaleContentToReview(fake, subject, {
      requiredPreMergeStepIds: new Set(["security-review", "code-review"]), mergeContent: singular,
    })).resolves.toMatchObject({ rerouted: true, reason: "seeded", nodeId: "security-review" });
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledTimes(1);
    expect(subject).toEqual(subjectBefore);
  });

  it.each([
    ["no-progress", task({ workflowStepResults: [{ workflowStepId: "security-review", reviewInputFingerprint: currentFingerprint }, { workflowStepId: "code-review", reviewInputFingerprint: currentFingerprint }] }), singular, store()],
    ["active-continuation", task(), singular, store(false)],
    ["no-review-route", task(), singular, store()],
    ["not-singular", task(), { kind: "workspace" }, store()],
    ["operator-held", task({ paused: true }), singular, store()],
  ] as const)("refuses %s without mutating results", async (reason, subject, content, fake) => {
    if (reason === "no-review-route") core.resolveWorkflowIrForTask.mockResolvedValueOnce({ name: "Review", nodes: [] });
    const before = structuredClone(subject.workflowStepResults);
    const result = await rerouteSingularStaleContentToReview(fake, subject, {
      requiredPreMergeStepIds: new Set(["security-review", "code-review"]), mergeContent: content as any,
    });
    expect(result).toMatchObject({ rerouted: false, reason });
    expect(subject.workflowStepResults).toEqual(before);
    if (reason !== "active-continuation") expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
  });
});
