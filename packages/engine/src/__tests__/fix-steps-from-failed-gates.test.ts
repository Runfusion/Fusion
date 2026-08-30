/*
FNXC:VerificationRemediation 2026-08-26-05:56:
The operator contract for Coding (Ideas) V2, stated as behaviour a card shows:

  - A failing test INSIDE a step is the step's own problem. The executor fixes it there, and it must
    never become a separate fix step \u2014 otherwise every red test during implementation would litter
    the checklist with work the session is already doing.
  - A failing FINAL verification (the project's configured test/build commands, run once after every
    planned step succeeds) DOES become fix steps: the session that could have fixed it in place is
    over, so the work has to be visible on the card and re-dispatched.
  - A Code Review REVISE does the same, from the reviewer's findings.

These tests drive the REAL routing seam (`requestPreMergeOptionalStepFix`) and the REAL appender
against the REAL V2 workflow IR, and assert on `task.steps` \u2014 the list an operator reads on the card.
A spy on the appender would prove only that a function was called; the appender's `Verification`
branch was present, correct, and caller-less for days, which is exactly the failure a spy misses.
*/
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStep } from "@fusion/core";
import { getBuiltinWorkflow } from "@fusion/core";

import { appendReviewRemediationSteps } from "../executor/append-review-remediation-steps.js";
import { requestPreMergeOptionalStepFix } from "../executor/request-pre-merge-optional-step-fix.js";

const FAILING_OUTPUT = [
  "test command `pnpm test` failed (exit 1):",
  " FAIL  packages/engine/src/retry.ts:42",
  "   expected 3 retries, received 1",
].join("\n");

const PROMPT = [
  "# Task: FN-VR-2",
  "",
  "## File Scope",
  "",
  "- `packages/engine/src/*`",
  "",
  "## Steps",
  "",
  "### Step 1: Add the retry guard",
  "",
  "### Step 2: Testing & Verification",
  "",
].join("\n");

/*
 A card that has finished every planned step and is at the verification boundary.
 The workflow is SELECTED by id and resolved through the real built-in registry, because that is what
 decides the bounce shape — injecting an IR object here would be resolved away and prove nothing.
*/
function harness(workflowId = "builtin:coding-ideas-v2") {
  const task = {
    id: "FN-VR-2",
    column: "in-progress",
    worktree: "/tmp/fn-vr-2",
    prompt: PROMPT,
    modifiedFiles: ["packages/engine/src/retry.ts"],
    steps: [
      { name: "Add the retry guard", status: "done" },
      { name: "Testing & Verification", status: "done" },
    ] as TaskStep[],
  } as Task;

  const store = {
    getTask: vi.fn(async () => task),
    getSettings: vi.fn(async () => ({ autoMerge: true })),
    logEntry: vi.fn(async () => undefined),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => { Object.assign(task, patch); return task; }),
    appendRemediationSteps: vi.fn(async (_id: string, steps: readonly TaskStep[], options: { wave?: number }) => {
      const appended = steps.map((step) => ({ ...step, status: "pending" as const }));
      task.steps = [...(task.steps ?? []), ...appended];
      return { task, appended, appendedCount: appended.length, wave: options.wave ?? 1 };
    }),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId })),
    getWorkflowDefinition: vi.fn(async (id: string) => {
      const workflow = getBuiltinWorkflow(id);
      return workflow ? { ir: workflow.ir } : undefined;
    }),
  };

  const sendTaskBackForFix = vi.fn(async () => undefined);
  const deps = {
    store: store as never,
    getRunContextFor: () => undefined,
    recoverMissingRequiredArtifacts: vi.fn(async () => undefined),
    parkPlanReviewReplanCapExhausted: vi.fn(async () => undefined),
    clearPausedAborted: vi.fn(),
    readTaskArtifact: async () => task.prompt,
    appendReviewRemediationSteps: (live: Task, info: never) => appendReviewRemediationSteps(
      { store: store as never, readTaskArtifact: async () => task.prompt, sendTaskBackForFix },
      live,
      info,
    ),
    workflowLifecycleMovesInFlight: new Set<string>(),
    sendTaskBackForFix,
  };

  const pending = () => (task.steps ?? []).filter((step) => step.status === "pending");
  return { task, store, deps, sendTaskBackForFix, pending };
}

describe("fix steps appear on the card when a gate fails", () => {
  it("turns a failing FINAL verification into named work on the card", async () => {
    const { deps, task, pending, sendTaskBackForFix } = harness();

    const scheduled = await requestPreMergeOptionalStepFix(deps as never, task.id, task, {
      stepName: "Verification (test)",
      feedback: FAILING_OUTPUT,
      phase: "pre-merge",
      status: "failed",
      nodeId: "verification",
    });

    expect(scheduled).toBe(true);
    expect(pending()).toHaveLength(1);
    expect(pending()[0]!.name).toContain("packages/engine/src/retry.ts");
    expect(pending()[0]!.remediation).toMatchObject({ gate: "Verification", wave: 1 });
    // Completed implementation work is preserved: remediation appends, it never reopens.
    expect(task.steps?.slice(0, 2).map((step) => step.status)).toEqual(["done", "done"]);
    // And the card is actually re-dispatched to run that step.
    expect(sendTaskBackForFix).toHaveBeenCalledTimes(1);
  });

  /*
  FNXC:VerificationRemediation 2026-08-26-06:31:
  `performWorkflowRerunBounce` PERSISTS the bounce path onto `task.worktree`. A caller holding the
  live checkout must therefore hand it over rather than let an unset task record supply "": that
  would wipe the pointer the remediation is about to run in, render the card "Unassigned", and stop
  self-healing reclaiming the worktree as idle.
  */
  it("bounces into the checkout it was given, not an unset task record", async () => {
    const { task, sendTaskBackForFix, store } = harness();
    task.worktree = undefined;

    await appendReviewRemediationSteps(
      { store: store as never, readTaskArtifact: async () => task.prompt, sendTaskBackForFix },
      task,
      { stepName: "Verification (test)", feedback: FAILING_OUTPUT, phase: "pre-merge", status: "failed", nodeId: "verification" },
      { worktreePath: "/tmp/live-checkout" },
    );

    expect(sendTaskBackForFix).toHaveBeenCalledTimes(1);
    expect(sendTaskBackForFix.mock.calls[0]?.[1]).toBe("/tmp/live-checkout");
  });

  it("turns a Code Review REVISE into named work on the card", async () => {
    const { deps, task, pending, sendTaskBackForFix } = harness();

    const scheduled = await requestPreMergeOptionalStepFix(deps as never, task.id, task, {
      stepName: "Code Review",
      feedback: "The guard is inverted.",
      phase: "pre-merge",
      status: "failed",
      verdict: "REVISE",
      nodeId: "code-review",
      findings: [{
        id: "finding-1",
        title: "inverted guard",
        body: "Reverse the retry guard condition",
        filePath: "packages/engine/src/retry.ts",
        line: 42,
        severity: "critical",
      }],
    });

    expect(scheduled).toBe(true);
    expect(pending()).toHaveLength(1);
    expect(pending()[0]!.name).toContain("Reverse the retry guard condition");
    expect(pending()[0]!.remediation).toMatchObject({
      gate: "Code Review",
      findingId: "finding-1",
      filePath: "packages/engine/src/retry.ts",
    });
    expect(sendTaskBackForFix).toHaveBeenCalledTimes(1);
  });

  /*
  A gate that failed for transport/provider reasons produced no verdict and therefore no findings.
  Manufacturing work from it would hand the executor an invented task.
  */
  it("creates nothing from a Code Review failure that carries no REVISE verdict", async () => {
    const { deps, task, pending, sendTaskBackForFix } = harness();

    const scheduled = await requestPreMergeOptionalStepFix(deps as never, task.id, task, {
      stepName: "Code Review",
      feedback: "reviewer session aborted",
      phase: "pre-merge",
      status: "failed",
      nodeId: "code-review",
    });

    expect(scheduled).toBe(false);
    expect(pending()).toHaveLength(0);
    expect(sendTaskBackForFix).not.toHaveBeenCalled();
  });

  /*
  THE RULE THIS PROTECTS: a red test inside a step is fixed inside that step. Only the two named
  gates may append work, so no per-step failure can reach the appender and litter the checklist.
  */
  it("never creates a fix step for a per-step failure", async () => {
    const { task, pending, sendTaskBackForFix, store } = harness();

    for (const nodeId of ["step-execute", "steps", "parse", undefined]) {
      const appended = await appendReviewRemediationSteps(
        { store: store as never, readTaskArtifact: async () => task.prompt, sendTaskBackForFix },
        task,
        { stepName: "Step 1", feedback: FAILING_OUTPUT, phase: "pre-merge", status: "failed", nodeId } as never,
      );
      expect(appended, `nodeId ${String(nodeId)} must not be able to append work`).toBe(false);
    }

    expect(pending()).toHaveLength(0);
    expect(store.appendRemediationSteps).not.toHaveBeenCalled();
    expect(sendTaskBackForFix).not.toHaveBeenCalled();
  });

  /*
  FNXC:ReportingOnlyGroup 2026-08-26-06:56:
  Documentation only documents. Measured on a real card (mult-021): its advisory REVISE asked for
  implementation work, this seam bounced the card to `in-progress`, and under this workflow's
  named-remediation policy `sendTaskBackForFix` reopened NOTHING — no pending step, foreach
  `already-expanded`, Code Review replayed over an unchanged tree, and the card merged when the
  second Documentation pass happened to pass. The demand was never implemented and two model calls
  were spent proving nothing.
  */
  it("records Documentation feedback without reopening implementation", async () => {
    const { deps, task, store, pending, sendTaskBackForFix } = harness();

    const scheduled = await requestPreMergeOptionalStepFix(deps as never, task.id, task, {
      stepName: "Documentation",
      feedback: "Implement the scoped removal and absence regression contract before documenting completion.",
      phase: "pre-merge",
      status: "advisory_failure",
      verdict: "REVISE",
      nodeId: "documentation-delivery",
    });

    expect(scheduled, "a reporter schedules no work").toBe(false);
    expect(pending()).toHaveLength(0);
    expect(sendTaskBackForFix, "the card must not bounce with an empty step list").not.toHaveBeenCalled();
    // The feedback still reaches the operator on the card.
    expect(store.logEntry.mock.calls.some(([, title]) => String(title).includes("cannot reopen implementation"))).toBe(true);
  });

  /*
  FNXC:EmptyBounceGuard 2026-08-26-06:56:
  The general invariant behind that fix: under named-remediation policy, only the gates that can
  APPEND work may bounce. Any other node reaching the bounce would send the card back with nothing
  to do, which is indistinguishable from a hang and re-reviews an unchanged tree on a loop.
  */
  it("refuses to bounce a card for a gate that owns no remediation", async () => {
    const { deps, task, pending, sendTaskBackForFix } = harness();

    const scheduled = await requestPreMergeOptionalStepFix(deps as never, task.id, task, {
      stepName: "Some Custom Gate",
      feedback: "please change something",
      phase: "pre-merge",
      status: "failed",
      verdict: "REVISE",
      nodeId: "some-custom-gate",
    });

    expect(scheduled).toBe(false);
    expect(pending()).toHaveLength(0);
    expect(sendTaskBackForFix).not.toHaveBeenCalled();
  });

  /*
  The appended shape is selected by the WORKFLOW, not by this seam: Coding (Ideas) reopens its
  trailing step instead, and must keep doing so.
  */
  it("leaves the inherited Coding (Ideas) workflow on its reopen-trailing bounce", async () => {
    const { deps, task, pending } = harness("builtin:coding-ideas");

    await requestPreMergeOptionalStepFix(deps as never, task.id, task, {
      stepName: "Code Review",
      feedback: "The guard is inverted.",
      phase: "pre-merge",
      status: "failed",
      verdict: "REVISE",
      nodeId: "code-review",
      findings: [{ id: "f1", title: "t", body: "b", filePath: "packages/engine/src/retry.ts", severity: "critical" }],
    });

    expect(pending(), "named remediation belongs to V2, not to the inherited board").toHaveLength(0);
  });
});
