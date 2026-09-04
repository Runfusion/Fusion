import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../../../core/src/__test-utils__/pg-test-harness.js";
import { resolveTrailingVerificationStepIndex } from "@fusion/core";
import { hasGit } from "./_pipeline-git-fixture.js";
import { PipelineSmokeHarness } from "./_pipeline-harness.js";

const describeIfReady = hasGit ? pgDescribe : describe.skip;

/*
FNXC:ReviewGatedRemediation 2026-08-25-03:10:
Proves the ONE behaviour a review-column workflow is bought for: a rejected Code Review returns the
card to implementation carrying NAMED work derived from the reviewer's findings, and that work is
actually executed and merged.

Why a dedicated file rather than extending S05: S05 asserts a different property (no merge without a
current approval) and gets there by racing the background auto-merge, which is what made it
intermittent under full-lane load. This drive is explicit and turn-by-turn — it never depends on when
a background merge happens to land — so it measures remediation instead of scheduling luck.

FNXC:ReviewGatedRemediation 2026-08-28-15:11:
The remediation checklist is also operator-visible execution history. A rejected review must leave every completed occurrence intact, append named fixes, and finish with a fresh verification occurrence that executes before the card can converge back through review and merge.
*/
describeIfReady("pipeline smoke: code review remediation", () => {
  const pg: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_pipeline_smoke_remediation",
    projectId: "pipeline-smoke-remediation",
  });
  let harness: PipelineSmokeHarness;

  beforeAll(pg.beforeAll);
  beforeEach(async () => {
    await pg.beforeEach();
    harness = await PipelineSmokeHarness.create(pg);
  });
  afterEach(async () => {
    await harness.dispose();
    await pg.afterEach();
  });
  afterAll(pg.afterAll);

  it("turns a Code Review rejection into named implementation work that converges to a merge", async () => {
    const task = await harness.createPipelineTask("builtin:coding-ideas-v2", {
      idPrefix: "REM",
      initialColumn: "hold",
    });

    /*
    One REVISE, then approvals. The scripted "revise" verdict carries a real finding with a file
    path, which is what `deriveRemediationSteps` needs; an empty rejection is a different contract
    (it parks for a human) and is covered by S07.
    */
    const behavior = { codeReviewModes: ["revise", "approve"] as const };

    let sawRemediationStep = false;
    let remediationStepName = "";
    let historyBeforeRemediation: string[] = [];
    let prior = await harness.freshTask(task.id);
    for (let turn = 0; turn < 24; turn += 1) {
      await harness.runProductionTurn(task.id, behavior as never);
      const live = await harness.freshTask(task.id);
      const remediation = (live.steps ?? []).find((step) => (step as { remediation?: unknown }).remediation !== undefined);
      if (remediation && !sawRemediationStep) {
        historyBeforeRemediation = (prior.steps ?? []).map((step) => step.name);
        for (const [index, step] of (prior.steps ?? []).entries()) {
          if (step.status === "done") {
            expect(live.steps?.[index]).toMatchObject({ name: step.name, status: "done" });
          }
        }
        sawRemediationStep = true;
        remediationStepName = remediation.name;
      }
      prior = live;
      if (live.mergeDetails?.mergeConfirmed === true) break;
    }

    const live = await harness.freshTask(task.id);

    // 1. The rejection produced NAMED work, not a bare bounce.
    const diagnostic = JSON.stringify({
      column: live.column,
      status: live.status,
      steps: live.steps,
      workflowStepResults: live.workflowStepResults,
      log: live.log,
      mergeConfirmed: live.mergeDetails?.mergeConfirmed,
    });
    expect(sawRemediationStep, `a Code Review REVISE must append a named remediation step: ${diagnostic}`).toBe(true);
    expect(remediationStepName.length).toBeGreaterThan(0);

    // 2. The original history remains in order, and the appended verification occurrence executed.
    expect((live.steps ?? []).slice(0, historyBeforeRemediation.length).map((step) => step.name))
      .toEqual(historyBeforeRemediation);
    expect(resolveTrailingVerificationStepIndex(live.steps ?? [])).toBe((live.steps ?? []).length - 1);
    const pending = (live.steps ?? []).filter((step) => step.status !== "done" && step.status !== "skipped");
    expect(pending.map((step) => `${step.name}:${step.status}`)).toEqual([]);

    // 3. And the card converged, proving the remediation loop is not merely visible but terminating.
    expect(live.mergeDetails?.mergeConfirmed).toBe(true);
  });
});
