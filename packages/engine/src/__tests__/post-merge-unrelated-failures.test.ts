import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";

vi.mock("../worktree/review-diff-fingerprint.js", async () => {
  const actual = await vi.importActual<typeof import("../worktree/review-diff-fingerprint.js")>("../worktree/review-diff-fingerprint.js");
  return {
    ...actual,
    computeCodeReviewInputFingerprint: vi.fn(async () => "a".repeat(64)),
    computeReviewDiffFingerprint: vi.fn(async () => "a".repeat(64)),
    resolveContentReviewInputProof: vi.fn(async () => ({ kind: "fingerprint", fingerprint: "a".repeat(64) })),
  };
});

import { TaskExecutor } from "../executor.js";
import {
  applyPostMergeBlockingGate,
  normalizePostMergeBlockingReason,
  parseWorkflowStepOutput,
} from "../executor/workflow-step-verdict.js";
import { createMockStore, mockedCreateFnAgent, resetExecutorMocks } from "./executor-test-helpers.js";

/*
FNXC:PostMergeUnrelatedFailures 2026-10-06-22:45:
Post-merge verification must not hold a landed task in review for failing tests the task did not cause.
Only a task-attributed regression or an in-progress post-landing run may keep a post-merge REVISE blocking.
*/

function task() {
  return {
    id: "FN-9600",
    title: "Landed change",
    description: "Already merged",
    column: "in-review",
    worktree: process.cwd(),
    branch: "fusion/fn-9600",
    baseCommitSha: "HEAD",
    dependencies: [],
    steps: [{ name: "Testing & Verification", status: "done" }],
    currentStep: 0,
    log: [],
    createdAt: "2026-10-06T00:00:00.000Z",
    updatedAt: "2026-10-06T00:00:00.000Z",
  } as any;
}

function step(phase: "post-merge" | "pre-merge") {
  return {
    id: phase === "post-merge" ? "post-merge-verification-step" : "graph:code-review",
    name: phase === "post-merge" ? "Post-merge verification" : "Code Review",
    description: "",
    mode: "prompt",
    phase,
    gateMode: "gate",
    prompt: "Verify the landed result.",
    toolMode: "readonly",
    enabled: true,
    optionalGroupId: phase === "post-merge" ? "post-merge-verification" : "code-review",
    createdAt: "2026-10-06T00:00:00.000Z",
    updatedAt: "2026-10-06T00:00:00.000Z",
  } as any;
}

function installReviewer(output: string) {
  mockedCreateFnAgent.mockImplementation(async () => {
    const listeners: Array<(event: any) => void> = [];
    return {
      session: {
        state: {},
        subscribe: (listener: (event: any) => void) => {
          listeners.push(listener);
          return () => undefined;
        },
        prompt: vi.fn(async () => {
          for (const listener of listeners) listener({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", partial: output, contentIndex: 0, delta: output },
          });
        }),
        dispose: vi.fn(),
      },
    } as any;
  });
}

async function runStep(phase: "post-merge" | "pre-merge", output: string) {
  installReviewer(output);
  const subject = task();
  const store = createMockStore();
  store.getTask.mockImplementation(async () => subject);
  const executor = new TaskExecutor(store as any, process.cwd());
  vi.spyOn(executor as any, "readTaskArtifact").mockResolvedValue("# Approved plan\n");
  const outcome = await (executor as any).executeWorkflowStep(subject, step(phase), process.cwd(), {});
  return { outcome, store };
}

describe("post-merge verification blocking contract", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it.each([
    ["unrelated failures", '{"verdict":"REVISE","notes":"Shard 2 fails two tests owned by FN-9512, unrelated to this change.","blockingReason":"unrelated"}'],
    ["no declared reason", '{"verdict":"REVISE","notes":"Shard 1 was cancelled and its timing artifact is absent."}'],
    ["prose revision request", "REQUEST REVISION\nShard 2 is red."],
  ])("records a post-merge REVISE with %s as APPROVE_WITH_NOTES", async (_label, output) => {
    const { outcome, store } = await runStep("post-merge", output);

    expect(outcome).toMatchObject({ success: true, revisionRequested: false, verdict: "APPROVE_WITH_NOTES" });
    expect(outcome.notes).not.toBe("");
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-9600",
      expect.stringContaining("recorded as APPROVE_WITH_NOTES"),
      expect.anything(),
    );
  });

  it.each(["task-regression", "evidence-pending"])("keeps a post-merge REVISE blocking for blockingReason %s", async (reason) => {
    const { outcome } = await runStep(
      "post-merge",
      `{"verdict":"REVISE","notes":"Blocking post-merge issue.","blockingReason":"${reason}"}`,
    );

    expect(outcome).toMatchObject({ success: false, revisionRequested: true, verdict: "REVISE" });
  });

  it("leaves post-merge approvals unchanged", async () => {
    const { outcome } = await runStep("post-merge", '{"verdict":"APPROVE","notes":"All lanes green."}');
    expect(outcome).toMatchObject({ success: true, verdict: "APPROVE" });
  });

  it("does not apply the post-merge rule to a pre-merge REVISE", async () => {
    const { outcome } = await runStep("pre-merge", '{"verdict":"REVISE","notes":"Missing null check in the new handler."}');
    expect(outcome).toMatchObject({ success: false, revisionRequested: true, verdict: "REVISE" });
  });
});

describe("post-merge blocking reason parsing", () => {
  it("normalizes accepted spellings and rejects everything else", () => {
    expect(normalizePostMergeBlockingReason("task-regression")).toBe("task-regression");
    expect(normalizePostMergeBlockingReason("Evidence_Pending")).toBe("evidence-pending");
    expect(normalizePostMergeBlockingReason("unrelated")).toBeUndefined();
    expect(normalizePostMergeBlockingReason(true)).toBeUndefined();
  });

  it("surfaces blockingReason from structured output", () => {
    expect(parseWorkflowStepOutput('{"verdict":"REVISE","notes":"x","blockingReason":"task-regression"}', { requireVerdict: true }))
      .toMatchObject({ verdict: "REVISE", blockingReason: "task-regression" });
    expect(parseWorkflowStepOutput('{"verdict":"REVISE","notes":"x","blockingReason":"nope"}', { requireVerdict: true }))
      .not.toHaveProperty("blockingReason");
  });

  it("downgrades only an unattributed REVISE", () => {
    expect(applyPostMergeBlockingGate({ verdict: "REVISE" })).toEqual({ verdict: "APPROVE_WITH_NOTES", downgraded: true });
    expect(applyPostMergeBlockingGate({ verdict: "REVISE", blockingReason: "evidence-pending" })).toEqual({ verdict: "REVISE", downgraded: false });
    expect(applyPostMergeBlockingGate({ verdict: "APPROVE" })).toEqual({ verdict: "APPROVE", downgraded: false });
  });
});
