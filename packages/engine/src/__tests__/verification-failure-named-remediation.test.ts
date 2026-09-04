/*
FNXC:VerificationRemediation 2026-08-26-04:58:
The FN-3345 deterministic verification gate runs `testCommand`/`buildCommand` after every planned
step succeeds and BEFORE the in-review handoff. When it goes red, the executor must receive NAMED
work to do. These tests pin which bounce shape each `stepReopenPolicy` gets, because the two are not
interchangeable and picking the wrong one silently discards the measurement:

  - `reopen-trailing` (builtin:coding, builtin:coding-ideas) reopens the trailing completed step.
  - `none` (builtin:coding-ideas-v2) forbids reopening, so remediation must ARRIVE as appended steps.

The defect: `none` reached `sendTaskBackForFix` all the same, which reopens nothing under that
policy. The card bounced to implementation with zero pending steps, the foreach answered
`already-expanded`, and it walked on to Code Review with the failing command unaddressed.
*/
import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import type { Task, TaskStep } from "@fusion/core";
import { planRemediationPlacement } from "@fusion/core";
import {
  BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR,
  BUILTIN_CODING_IDEAS_WORKFLOW_IR,
  BUILTIN_CODING_WORKFLOW_IR,
  resolveStepReopenPolicy,
} from "@fusion/core";

import {
  appendReviewRemediationSteps,
  type AppendReviewRemediationOutcome,
} from "../executor/append-review-remediation-steps.js";
import {
  normalizeVerificationEvidence,
  verificationEvidenceDigest,
} from "../executor/derive-remediation-steps.js";
import { bounceVerificationFailure } from "../executor/bounce-verification-failure.js";

const FAILING_TEST_OUTPUT =
  "test command `pnpm test` failed (exit 1):\n"
  + " FAIL  packages/engine/src/retry.ts:42\n"
  + "   expected 3 retries, received 1\n";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-VR-1",
    column: "in-progress",
    worktree: "/tmp/fn-vr-1",
    steps: [{ name: "Implementation", status: "done" }, { name: "Testing & Verification", status: "done" }],
    modifiedFiles: ["packages/engine/src/retry.ts"],
    ...overrides,
  } as Task;
}

function seam(overrides: { outcome?: AppendReviewRemediationOutcome } = {}) {
  const live = task();
  const deps = {
    store: { getTask: vi.fn(async () => live) },
    appendReviewRemediationSteps: vi.fn(async () => overrides.outcome ?? "appended" as const),
    sendTaskBackForFix: vi.fn(async () => undefined),
    clearCompletedTaskWatchdog: vi.fn(),
  };
  return { deps, live };
}

function realAppenderHarness(live: Task) {
  const appendRemediationSteps = vi.fn(async (_id: string, candidates: readonly TaskStep[], options: { wave?: number }) => {
    const appended = candidates.map((candidate) => ({ ...candidate, status: "pending" as const }));
    const placement = planRemediationPlacement(live.steps ?? [], appended);
    live.steps = placement.steps;
    return { task: live, appended, appendedCount: appended.length, wave: options.wave ?? 1, ...placement };
  });
  const store = {
    appendRemediationSteps,
    getTask: vi.fn(async () => live),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => Object.assign(live, patch)),
    logEntry: vi.fn(async () => undefined),
  };
  const sendTaskBackForFix = vi.fn(async () => undefined);
  const append = (info: { feedback: string; stepName?: string }) => appendReviewRemediationSteps(
    { store: store as never, readTaskArtifact: async () => live.prompt, sendTaskBackForFix },
    live,
    {
      stepName: info.stepName ?? "Verification (test)",
      feedback: info.feedback,
      phase: "pre-merge",
      status: "failed",
      nodeId: "verification",
    },
    { worktreePath: live.worktree },
  );
  return { append, appendRemediationSteps, sendTaskBackForFix, store };
}

describe("deterministic verification failure → named remediation", () => {
  it("appends named work instead of an empty bounce when the workflow forbids reopening", async () => {
    const { deps, live } = seam();

    // The policy under test is the one the real workflow resolves, not a hand-written constant.
    expect(resolveStepReopenPolicy(BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR)).toBe("none");

    const outcome = await bounceVerificationFailure(deps, {
      task: task({ modifiedFiles: undefined }),
      worktreePath: "/tmp/fn-vr-1",
      failedType: "test",
      feedback: FAILING_TEST_OUTPUT,
      reason: "Deterministic verification failed after 3 fix attempts",
      stepReopenPolicy: resolveStepReopenPolicy(BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR),
    });

    expect(outcome).toBe("named-remediation");
    expect(deps.appendReviewRemediationSteps).toHaveBeenCalledWith(
      // Re-read: a stale pre-session snapshot would classify the executor's own files as upstream
      // work and park instead of fixing.
      live,
      expect.objectContaining({
        nodeId: "verification",
        stepName: "Verification (test)",
        feedback: FAILING_TEST_OUTPUT,
        status: "failed",
        phase: "pre-merge",
      }),
      /*
      FNXC:VerificationRemediation 2026-08-26-06:31:
      The checkout this gate just verified is handed over explicitly. `performWorkflowRerunBounce`
      PERSISTS the path it receives onto `task.worktree`, so falling back to an empty task record
      would wipe the pointer the remediation is about to run in — the card renders "Unassigned" and
      self-healing can no longer reclaim the worktree. The legacy bounce below always passed it.
      */
      { worktreePath: "/tmp/fn-vr-1" },
    );
    // Remediation performs the bounce itself; a second one would double-dispatch the executor.
    expect(deps.sendTaskBackForFix).not.toHaveBeenCalled();
    expect(deps.clearCompletedTaskWatchdog).not.toHaveBeenCalled();
  });

  it("treats a non-blocking remediation release as terminal rather than re-dispatching the executor", async () => {
    const { deps } = seam({ outcome: "released-verification-no-progress" });

    const outcome = await bounceVerificationFailure(deps, {
      task: task(),
      worktreePath: "/tmp/fn-vr-1",
      failedType: "build",
      feedback: "build command `pnpm build` failed (exit 2):\nunresolved import",
      reason: "Deterministic verification failed (build)",
      stepReopenPolicy: "none",
    });

    expect(outcome).toBe("released-non-blocking");
    // A follow-up bounce would re-dispatch an executor with no named work.
    expect(deps.sendTaskBackForFix).not.toHaveBeenCalled();
    expect(deps.clearCompletedTaskWatchdog).toHaveBeenCalledWith("FN-VR-1");
  });

  it("uses named remediation on reopen-trailing workflows when findings are actionable", async () => {
    for (const ir of [BUILTIN_CODING_WORKFLOW_IR, BUILTIN_CODING_IDEAS_WORKFLOW_IR]) {
      const { deps } = seam();
      expect(resolveStepReopenPolicy(ir)).toBe("reopen-trailing");

      const outcome = await bounceVerificationFailure(deps, {
        task: task(),
        worktreePath: "/tmp/fn-vr-1",
        failedType: "test",
        feedback: FAILING_TEST_OUTPUT,
        reason: "Deterministic verification failed after 3 fix attempts",
        stepReopenPolicy: resolveStepReopenPolicy(ir),
      });

      expect(outcome).toBe("named-remediation");
      expect(deps.appendReviewRemediationSteps).toHaveBeenCalledTimes(1);
      expect(deps.sendTaskBackForFix).not.toHaveBeenCalled();
    }
  });

  it("does not reopen when no actionable finding can be derived", async () => {
    const { deps } = seam({ outcome: "released-no-actionable-findings" });
    const subject = task();

    const outcome = await bounceVerificationFailure(deps, {
      task: subject,
      worktreePath: "/tmp/fn-vr-1",
      failedType: "test",
      feedback: "Verification failed without a file-specific finding",
      reason: "Deterministic verification failed",
      stepReopenPolicy: "reopen-trailing",
    });

    expect(outcome).toBe("released-non-blocking");
    expect(deps.sendTaskBackForFix).not.toHaveBeenCalled();
    expect(deps.clearCompletedTaskWatchdog).toHaveBeenCalledWith("FN-VR-1");
  });

  /*
  The whole point of the change, end to end through the real remediation authority: a failing test
  command becomes a pending step naming the file to fix, and the PROMPT.md File Scope grows to cover
  it. A spy on `appendReviewRemediationSteps` cannot prove this — its `Verification` branch had been
  caller-less since the graph's `verification` node was removed, so it was present, correct, and dead.
  */
  it("turns the failing command's output into pending named steps the executor can run", async () => {
    const live = task({
      prompt: "# Task\n\n## File Scope\n\n- `packages/engine/src/executor/*`\n\n## Steps\n",
      steps: [
        { name: "Implementation", status: "done" },
        { name: "Testing & Verification", status: "done" },
      ],
    });
    const store = {
      appendRemediationSteps: vi.fn(async (_id: string, steps: readonly TaskStep[], options: { wave?: number }) => {
        const appended = steps.map((step) => ({ ...step, status: "pending" as const }));
        const placement = planRemediationPlacement(live.steps ?? [], appended);
        live.steps = placement.steps;
        return { task: live, appended, appendedCount: appended.length, wave: options.wave ?? 1, ...placement };
      }),
      getTask: vi.fn(async () => live),
      updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => {
        Object.assign(live, patch);
        return live;
      }),
      logEntry: vi.fn(async () => undefined),
    };
    const sendTaskBackForFix = vi.fn(async () => undefined);

    const appended = await appendReviewRemediationSteps(
      {
        store: store as never,
        readTaskArtifact: async () => live.prompt,
        sendTaskBackForFix,
      },
      live,
      {
        stepName: "Verification (test)",
        feedback: FAILING_TEST_OUTPUT,
        phase: "pre-merge",
        status: "failed",
        nodeId: "verification",
      },
    );

    expect(appended).toBe("appended");
    const pending = (live.steps ?? []).filter((step) => step.status === "pending");
    expect(pending).toHaveLength(2);
    expect(pending[0]!.name).toContain("packages/engine/src/retry.ts");
    expect(pending[0]!.remediation).toMatchObject({
      gate: "Verification",
      gateStepId: "verification",
      filePath: "packages/engine/src/retry.ts",
      wave: 1,
    });
    expect(live.steps?.map((step) => [step.name, step.status])).toEqual([
      ["Implementation", "done"],
      ["Testing & Verification", "done"],
      [expect.stringContaining("packages/engine/src/retry.ts"), "pending"],
      ["Testing & Verification", "pending"],
    ]);
    // The executor may only edit what the spec declares, so remediation widens the declared scope.
    expect(live.prompt).toContain("- `packages/engine/src/retry.ts`");
    // And the executor is actually re-dispatched to run that step.
    expect(sendTaskBackForFix).toHaveBeenCalledTimes(1);
  });

  it("appends a fourth verification wave when the measured failure changes", async () => {
    const prior = "FAIL packages/engine/src/retry.ts:42 expected 3, received 1";
    const live = task({
      steps: [{
        name: "Fix prior verification",
        status: "done",
        remediation: {
          wave: 3,
          gate: "Verification",
          gateStepId: "verification",
          evidenceDigest: verificationEvidenceDigest(prior),
          detail: "prior failure",
        },
      }],
    });
    const real = realAppenderHarness(live);
    const deps = {
      store: real.store,
      appendReviewRemediationSteps: vi.fn((current: Task, info: Parameters<typeof appendReviewRemediationSteps>[2], options?: { worktreePath?: string }) =>
        appendReviewRemediationSteps(
          { store: real.store as never, readTaskArtifact: async () => current.prompt, sendTaskBackForFix: real.sendTaskBackForFix },
          current,
          info,
          options,
        )),
      sendTaskBackForFix: vi.fn(async () => undefined),
      clearCompletedTaskWatchdog: vi.fn(),
    };

    await expect(bounceVerificationFailure(deps, {
      task: live,
      worktreePath: live.worktree!,
      failedType: "test",
      feedback: "FAIL packages/engine/src/retry.ts:42 expected 3, received 2",
      reason: "Verification changed",
      stepReopenPolicy: "none",
    })).resolves.toBe("named-remediation");
    expect(live.steps).toContainEqual(expect.objectContaining({
      status: "pending",
      remediation: expect.objectContaining({ wave: 4, evidenceDigest: expect.any(String) }),
    }));
    expect(real.sendTaskBackForFix).toHaveBeenCalledTimes(1);
  });

  it("releases identical normalized verification evidence without lifecycle mutation", async () => {
    const feedback = "FAIL packages/engine/src/retry.ts:42 expected 3, received 1";
    const live = task({
      status: null,
      paused: false,
      steps: [{
        name: "Fix prior verification",
        status: "done",
        remediation: {
          wave: 1,
          gate: "Verification",
          gateStepId: "verification",
          evidenceDigest: verificationEvidenceDigest(feedback),
        },
      }],
    });
    const real = realAppenderHarness(live);

    await expect(real.append({ feedback })).resolves.toBe("released-verification-no-progress");
    expect(real.store.logEntry).toHaveBeenCalledWith(
      live.id,
      "Review remediation released as non-blocking",
      "review-remediation-verification-no-progress",
    );
    expect(real.appendRemediationSteps).not.toHaveBeenCalled();
    expect(real.sendTaskBackForFix).not.toHaveBeenCalled();
    expect(live).toMatchObject({ status: null, paused: false });
  });

  it("normalizes only volatile verification paint, durations, and timestamps", async () => {
    const prior = "\u001b[31mFAIL\u001b[0m  packages/engine/src/retry.ts:42 at 2026-08-28T12:00:00Z\n elapsed 125ms";
    const current = "FAIL packages/engine/src/retry.ts:42 at 2026-08-28T12:01:30Z\r\n elapsed 2.5s";
    expect(normalizeVerificationEvidence(prior)).toBe(normalizeVerificationEvidence(current));
    const live = task({
      steps: [{ name: "prior", status: "done", remediation: { wave: 1, gate: "Verification", gateStepId: "verification", evidenceDigest: verificationEvidenceDigest(prior) } }],
    });
    const real = realAppenderHarness(live);
    await expect(real.append({ feedback: current })).resolves.toBe("released-verification-no-progress");
  });

  it("appends changed failure text even when the file reference is unchanged", async () => {
    const prior = "FAIL packages/engine/src/retry.ts:42 expected 3, received 1";
    const current = "FAIL packages/engine/src/retry.ts:42 expected 3, received 2";
    const live = task({
      steps: [{ name: "prior", status: "done", remediation: { wave: 1, gate: "Verification", gateStepId: "verification", evidenceDigest: verificationEvidenceDigest(prior) } }],
    });
    const real = realAppenderHarness(live);
    await expect(real.append({ feedback: current })).resolves.toBe("appended");
    expect(real.appendRemediationSteps).toHaveBeenCalledTimes(1);
  });

  it("appends changed fileless failure text despite the shared fallback candidate", async () => {
    const prior = "Assertion failed: expected enabled, received disabled";
    const current = "Assertion failed: expected ready, received blocked";
    const live = task({
      steps: [{ name: "prior", status: "done", remediation: { wave: 1, gate: "Verification", gateStepId: "verification", evidenceDigest: verificationEvidenceDigest(prior) } }],
    });
    const real = realAppenderHarness(live);
    await expect(real.append({ feedback: current })).resolves.toBe("appended");
    expect(live.steps).toContainEqual(expect.objectContaining({ name: "Fix: Fix failing Verification (test)", status: "pending" }));
  });

  it("does not strand legacy verification waves without an evidence digest", async () => {
    const live = task({
      steps: [{ name: "legacy", status: "done", remediation: { wave: 2, gate: "Verification", gateStepId: "verification" } }],
    });
    const real = realAppenderHarness(live);
    await expect(real.append({ feedback: FAILING_TEST_OUTPUT })).resolves.toBe("appended");
  });

  it("ignores Code Review provenance when comparing verification evidence", async () => {
    const live = task({
      steps: [{
        name: "code review fix",
        status: "done",
        remediation: {
          wave: 4,
          gate: "Code Review",
          gateStepId: "code-review",
          evidenceDigest: verificationEvidenceDigest(FAILING_TEST_OUTPUT),
        },
      }],
    });
    const real = realAppenderHarness(live);
    await expect(real.append({ feedback: FAILING_TEST_OUTPUT })).resolves.toBe("appended");
    expect(live.steps).toContainEqual(expect.objectContaining({
      status: "pending",
      remediation: expect.objectContaining({ gate: "Verification", wave: 5 }),
    }));
  });

  /*
  Structural ratchet, not prose: the verification gate must reach its bounce ONLY through the policy
  seam. A future edit re-adding a raw `deps.sendTaskBackForFix(...)` there would silently restore the
  empty bounce for `none` workflows, and no behavioural test in this file would notice.
  */
  it("routes every verification bounce through the policy seam", async () => {
    const source = await readFile(new URL("../executor/run-implementation.ts", import.meta.url), "utf8");
    expect(source).toContain("bounceVerificationFailureSeam");
    expect(source).not.toContain("deps.sendTaskBackForFix(");
  });
});
