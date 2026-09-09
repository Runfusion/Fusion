import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { activeSessionRegistry } from "../../agents/active-session-registry.js";
import type { PipelineTaskSeed } from "./_pipeline-harness.js";
import type { PipelineScriptedMergeBehavior } from "./_pipeline-mock-scripts.js";
import type { PipelineScenario, PipelineScenarioContext, PipelineScenarioDriver } from "./_pipeline-scenarios.js";

function driver(label: string, run: (context: PipelineScenarioContext) => Promise<void>): PipelineScenarioDriver {
  return { label, run };
}

function taskFor(context: PipelineScenarioContext): PipelineTaskSeed {
  if (!context.task) throw new Error(`Pipeline scenario has no arranged task (${context.workflowId}).`);
  return context.task;
}

async function arrangeTask(
  context: PipelineScenarioContext,
  idPrefix: string,
  options: { codeReview?: boolean; initialColumn?: "creation" | "hold"; noCommitsExpected?: boolean } = {},
): Promise<PipelineTaskSeed> {
  const task = await context.harness.createPipelineTask(context.workflowId, {
    idPrefix,
    initialColumn: options.initialColumn ?? "hold",
    codeReview: options.codeReview,
    noCommitsExpected: options.noCommitsExpected,
  });
  context.task = task;
  context.initialIntegrationSha = await context.harness.integrationSha();
  return task;
}

async function driveMerged(
  context: PipelineScenarioContext,
  behavior: PipelineScriptedMergeBehavior = {},
): Promise<void> {
  const task = taskFor(context);
  context.result = await context.harness.driveToDeclaredTerminal(task.id, "merged-done", behavior);
  const live = await context.harness.freshTask(task.id);
  await context.harness.assertProductionStageEvidence(task.id, {
    planReview: (live.enabledWorkflowSteps ?? []).includes("plan-review"),
    codeReview: (live.enabledWorkflowSteps ?? []).includes("code-review"),
    implementation: !live.noCommitsExpected,
  });
}

async function driveReviewedManualHold(
  context: PipelineScenarioContext,
  behavior: PipelineScriptedMergeBehavior = {},
): Promise<void> {
  const task = taskFor(context);
  await context.harness.driveToManualMergeHold(task.id, behavior);
}

async function releaseManualMerge(context: PipelineScenarioContext): Promise<void> {
  const task = taskFor(context);
  await context.harness.store.updateSettings({ autoMerge: true });
  const merged = await context.harness.admitAndMerge(task.id, { manual: true });
  if (!merged.result?.merged) throw merged.error ?? new Error(`${task.id} did not merge after manual release.`);
  context.result = await context.harness.assertTerminal(task.id, "merged-done");
}

/**
 * FNXC:PipelineSmoke 2026-08-23-19:31:
 * These are executable production drives. Normal rows begin in their workflow's real intake or
 * hold lane, then the TaskExecutor graph, hold-release sweep, worktree acquisition, scripted
 * review sessions, ProjectEngine admission, and local merger establish every asserted lifecycle
 * fact. Direct durable state changes are restricted to the two documented incident-row races.
 */
export async function executePipelineScenario(
  scenario: PipelineScenario,
  context: PipelineScenarioContext,
): Promise<void> {
  await scenario.arrange.run(context);
  await scenario.act.run(context);
  if (context.result?.observedTerminal !== scenario.expectedTerminal || context.result.wedge) {
    throw new Error(`${scenario.id} observed ${context.result?.observedTerminal ?? "no terminal"}; expected ${scenario.expectedTerminal}.`);
  }
  if (scenario.recovery) {
    await scenario.recovery.run(context);
    await context.harness.assertTerminal(taskFor(context).id, scenario.recoveryExpectedTerminal ?? "merged-done");
  }
}

export const PIPELINE_SCENARIO_DRIVERS = {
  s01Arrange: driver("create an Idea in the manual intake", async (context) => {
    const task = await arrangeTask(context, "S01", { initialColumn: "creation" });
    await context.harness.assertTerminal(task.id, "inert-intake");
  }),
  s01Act: driver("operator-promote the Idea and execute the graph", async (context) => {
    const task = taskFor(context);
    await context.harness.store.moveTask(task.id, task.holdColumn, { moveSource: "user" });
    await driveMerged(context);
  }),

  s02Arrange: driver("create a selected workflow task in Planning", async (context) => {
    await arrangeTask(context, "S02");
  }),
  s02Act: driver("run Planning through merge on the production graph", driveMerged),

  /*
  FNXC:PipelineSmoke 2026-08-26-10:11:
  THE JOURNAL IS A DELIVERABLE. Every anomaly reported from a live board this week was visible in the
  task log and invisible to this lane, because no scenario asserted what an operator actually reads:
  an abort breadcrumb on a card that was never interrupted, the same line written twice, and an
  approval whose own text admitted it had verified nothing.

  Those are not cosmetic. Each one is the observable trace of a real defect — a lying provenance
  label, a duplicated invocation, and a merge approved without checks — and each was dismissed as log
  noise until it was traced. Asserting the journal is how this lane catches that class at all.

  The checks are deliberately about SHAPE, never wording: a specific sentence would pin prose and
  break on the first honest rewording.
  */
  s20Arrange: driver("create a task whose operator journal must stay clean", async (context) => {
    await arrangeTask(context, "S20");
  }),
  s20Act: driver("drive to merge, then assert the journal an operator reads has no anomalies", async (context) => {
    const task = taskFor(context);
    context.result = await context.harness.driveToDeclaredTerminal(task.id, "merged-done");

    const live = await context.harness.freshTask(task.id);
    const entries = (live.log ?? []).map((entry) => `${entry.action ?? ""}`.trim()).filter(Boolean);
    const violations: string[] = [];

    /* A card that completed normally was never interrupted, so it must not claim it was. */
    const abortClaims = entries.filter((line) => line.startsWith("Pause abort marked"));
    if (abortClaims.length > 0) {
      violations.push(`journal claims an abort on an uninterrupted card: ${abortClaims.join(" | ")}`);
    }

    /* The same sentence twice in a row is a duplicated invocation wearing a log line. */
    for (let index = 1; index < entries.length; index += 1) {
      if (entries[index] === entries[index - 1]) {
        violations.push(`journal repeats a line back to back: ${entries[index]}`);
        break;
      }
    }

    /* An approval that says it could not check is the failure mode this whole series was about. */
    const unverifiedApproval = entries.find((line) =>
      /approved|approve\b/i.test(line) && /could not run|unavailable|nothing was verified|not verified/i.test(line));
    if (unverifiedApproval) {
      violations.push(`journal records an approval that verified nothing: ${unverifiedApproval}`);
    }

    if (violations.length > 0) {
      throw new Error(`S20 operator journal anomalies:\n- ${violations.join("\n- ")}`);
    }
  }),

  s03Arrange: driver("create an unpromoted Idea", async (context) => {
    await arrangeTask(context, "S03", { initialColumn: "creation" });
  }),
  s03Act: driver("run recovery without an operator promotion", async (context) => {
    const task = taskFor(context);
    await context.harness.exerciseSchedulerAndRecovery(task.id);
    context.result = await context.harness.assertTerminal(task.id, "inert-intake");
  }),

  s04Arrange: driver("create a Planning-lane task for Plan Review rework", async (context) => {
    await arrangeTask(context, "S04");
  }),
  s04Act: driver("script two Plan Review revisions then approval", async (context) => {
    await driveMerged(context, { planReviewModes: ["revise", "revise", "approve"] });
  }),

  s05Arrange: driver("create a real reviewed branch before the FN-175 row", async (context) => {
    await arrangeTask(context, "S05");
  }),
  s05Act: driver("reconstruct missing verdict only after graph review, then recover", async (context) => {
    const task = taskFor(context);
    await driveReviewedManualHold(context, { codeReviewModes: ["revise", "approve"] });
    const approvals = await context.harness.arrangeFn175MissingVerdictRow(task.id);
    await context.harness.store.updateSettings({ autoMerge: true });
    const before = await context.harness.integrationSha();
    const blocked = await context.harness.admitAndMerge(task.id, { manual: true });
    const after = await context.harness.integrationSha();
    if (!blocked.error || before !== after) {
      throw new Error("S05 admitted a merge without a current Code Review verdict.");
    }
    await context.harness.restoreProductionReviewResults(task.id, approvals);
    const merged = await context.harness.admitAndMerge(task.id, { manual: true });
    if (!merged.result?.merged) throw merged.error ?? new Error("S05 did not merge after restoring the graph-produced approval.");
    context.result = await context.harness.assertTerminal(task.id, "merged-done");
  }),

  s06Arrange: driver("create a real reviewed branch for the in-flight revocation", async (context) => {
    await arrangeTask(context, "S06");
  }),
  s06Act: driver("hold merge ref advance, record review revocation, then remediate", async (context) => {
    const task = taskFor(context);
    await driveReviewedManualHold(context);
    await context.harness.store.updateSettings({ autoMerge: true });
    let releaseMerge: (() => void) | undefined;
    let enteredMerge: (() => void) | undefined;
    const release = new Promise<void>((resolve) => { releaseMerge = resolve; });
    const entered = new Promise<void>((resolve) => { enteredMerge = resolve; });
    const before = await context.harness.integrationSha();
    const pending = context.harness.admitAndMerge(task.id, {
      manual: true,
      behavior: { waitForMerge: release, onMergeEntered: () => enteredMerge?.() },
    });
    await entered;
    const approvals = await context.harness.recordInFlightCodeReviewRevise(task.id);
    releaseMerge?.();
    const revoked = await pending;
    const after = await context.harness.integrationSha();
    if (!revoked.error || before !== after) {
      throw new Error("S06 landed a merge after the in-flight Code Review was revoked.");
    }
    await context.harness.restoreProductionReviewResults(task.id, approvals);
    const merged = await context.harness.admitAndMerge(task.id, { manual: true });
    if (!merged.result?.merged) throw merged.error ?? new Error("S06 remediation did not reach ProjectEngine merge admission.");
    context.result = await context.harness.assertTerminal(task.id, "merged-done");
  }),

  s07Arrange: driver("create a task for an unactionable Code Review rejection", async (context) => {
    await arrangeTask(context, "S07");
  }),
  s07Act: driver("let the real Code Review park the unactionable rejection", async (context) => {
    const task = taskFor(context);
    for (let turn = 0; turn < 10; turn += 1) {
      await context.harness.runProductionTurn(task.id, { codeReviewModes: ["empty-revise"] });
      const live = await context.harness.freshTask(task.id);
      if (live.workflowStepResults?.some((result) => result.workflowStepId === "code-review" && result.verdict === "REVISE")) {
        context.result = await context.harness.assertTerminal(task.id, "parked");
        return;
      }
    }
    throw new Error("S07 did not persist its real unactionable Code Review rejection.");
  }),
  /*
  FNXC:PipelineSmoke 2026-08-24-22:40:
  The declared recovery for a park is "operator retry, or the cause disappears". Named remediation
  parks an unactionable rejection as `awaiting-approval` with `paused: true` — deliberately, because
  there is no actionable finding to derive work from, so a human must decide. A drive alone cannot
  move a paused card, so the recovery must first perform the operator's half of that contract.
  Releasing an EXPLICIT awaiting-approval park is the operator action under test; it is not a way to
  make an unrelated failure pass, and the merge that follows is still fully asserted.
  */
  s07Recovery: driver("release the operator park, then approve through the restored graph session", async (context) => {
    const parked = context.result;
    const task = taskFor(context);
    const live = await context.harness.freshTask(task.id);
    if (live.paused === true || live.status === "awaiting-approval") {
      await context.harness.store.updateTask(task.id, {
        paused: false,
        pausedReason: undefined,
        status: undefined,
        awaitingApprovalReason: undefined,
      } as never);
    }
    await driveMerged(context, { planReviewModes: ["approve"], codeReviewModes: ["approve"] });
    context.result = parked;
  }),

  s08Arrange: driver("disable only Code Review on the selected task", async (context) => {
    await arrangeTask(context, "S08", { codeReview: false });
  }),
  s08Act: driver("run the still-real Planning and implementation path", driveMerged),

  s09Arrange: driver("create a reviewed branch before registering the executor", async (context) => {
    await arrangeTask(context, "S09");
  }),
  s09Act: driver("prove live executor ownership excludes real merge admission", async (context) => {
    const task = taskFor(context);
    await driveReviewedManualHold(context);
    // A no-op sentinel proves the queue can make forward progress without changing the
    // integration ref. The first durable completion identifies which task was admitted.
    const sentinel = await context.harness.createPipelineTask(context.workflowId, {
      idPrefix: "S09-SENTINEL",
      codeReview: false,
      noCommitsExpected: true,
    });
    await context.harness.driveToManualMergeHold(sentinel.id, { commitImplementation: false });
    await context.harness.store.updateSettings({ autoMerge: true });
    const worktree = await context.harness.requireTaskWorktree(task.id);
    const before = await context.harness.integrationSha();
    activeSessionRegistry.registerPath(worktree, {
      taskId: task.id,
      kind: "executor",
      ownerKey: `pipeline-live:${task.id}`,
    });
    const firstCompletion = new Promise<"blocked" | "sentinel">((resolve) => {
      const onUpdated = (updated: { id: string; column?: string; mergeDetails?: { mergeConfirmed?: boolean } }) => {
        if (updated.id !== task.id && updated.id !== sentinel.id) return;
        if (updated.column !== task.completeColumn && updated.mergeDetails?.mergeConfirmed !== true) return;
        context.harness.store.off("task:updated", onUpdated);
        resolve(updated.id === task.id ? "blocked" : "sentinel");
      };
      context.harness.store.on("task:updated", onUpdated);
    });
    try {
      await context.harness.tryEnqueueAutomaticMerge(task.id);
      await context.harness.tryEnqueueAutomaticMerge(sentinel.id);
      const admitted = await firstCompletion;
      const during = await context.harness.integrationSha();
      if (admitted === "blocked" || during !== before) {
        throw new Error(`S09 advanced the integration ref while the executor session was live (${JSON.stringify({ admitted, before, during })}).`);
      }
    } finally {
      activeSessionRegistry.unregisterPath(worktree);
    }
    await context.harness.enqueueAndWaitForAutomaticMerge(task.id);
    context.result = await context.harness.assertTerminal(task.id, "merged-done");
  }),

  s10Arrange: driver("create a reviewed branch for merger cleanup", async (context) => {
    await arrangeTask(context, "S10");
  }),
  s10Act: driver("register successor liveness during real merger cleanup", async (context) => {
    const task = taskFor(context);
    await driveReviewedManualHold(context);
    await context.harness.store.updateSettings({ autoMerge: true });
    const worktree = await context.harness.requireTaskWorktree(task.id);
    let releaseMerge: (() => void) | undefined;
    let enteredMerge: (() => void) | undefined;
    const release = new Promise<void>((resolve) => { releaseMerge = resolve; });
    const entered = new Promise<void>((resolve) => { enteredMerge = resolve; });
    const pending = context.harness.admitAndMerge(task.id, {
      manual: true,
      behavior: { waitForMerge: release, onMergeEntered: () => enteredMerge?.() },
    });
    await entered;
    activeSessionRegistry.registerPath(worktree, {
      taskId: task.id,
      kind: "executor",
      ownerKey: `pipeline-cleanup:${task.id}`,
    });
    try {
      releaseMerge?.();
      const merged = await pending;
      if (!merged.result?.merged || !existsSync(worktree) || !activeSessionRegistry.isPathActive(worktree)) {
        throw merged.error ?? new Error("S10 merger cleanup severed an active session worktree.");
      }
      const audits = await context.harness.store.getRunAuditEventsAsync({ taskId: task.id });
      if (!audits.some((event) => event.mutationType === "worktree:removal-refused-active-session")) {
        throw new Error("S10 did not persist the active-session cleanup-refusal audit.");
      }
    } finally {
      activeSessionRegistry.unregisterPath(worktree);
    }
    context.result = await context.harness.assertTerminal(task.id, "merged-done");
  }),

  s11Arrange: driver("create a task for production worktree recovery", async (context) => {
    await arrangeTask(context, `S11-${context.variant ?? "default"}`);
  }),
  s11Act: driver("exercise each real WorktreePool acquisition disruption", async (context) => {
    const task = taskFor(context);
    const variant = context.variant;
    if (
      variant !== "pool-saturated"
      && variant !== "recycled"
      && variant !== "absent"
      && variant !== "vanished-mid-step"
    ) {
      throw new Error(`S11 requires a declared worktree variant, received ${String(variant)}.`);
    }
    await context.harness.arrangeWorktreeRecoveryVariant(task.id, variant);
    await driveMerged(context, { codeReviewModes: ["approve"] });
  }),

  s12Arrange: driver("create a Code Review rework candidate", async (context) => {
    await arrangeTask(context, "S12");
  }),
  s12Act: driver("keep graph-owned corrections while capacity is unavailable", async (context) => {
    const task = taskFor(context);
    await context.harness.store.updateSettings({ maxConcurrent: 0 });
    await context.harness.runProductionTurn(task.id, { codeReviewModes: ["revise", "approve"] });
    if ((await context.harness.freshTask(task.id)).status === "failed") {
      throw new Error("S12 failed while capacity was unavailable.");
    }
    await context.harness.store.updateSettings({ maxConcurrent: 2 });
    await driveMerged(context, { codeReviewModes: ["approve"] });
  }),

  s13Arrange: driver("create a task branch before a local integration conflict", async (context) => {
    await arrangeTask(context, "S13");
  }),
  s13Act: driver("resolve a same-file local conflict through the scripted merger", async (context) => {
    const task = taskFor(context);
    const taskBranchContent = "# task branch conflict\n";
    const scriptedResolution = "# scripted merger resolution\n";
    const behavior: PipelineScriptedMergeBehavior = {
      implementationFile: { path: "README.md", content: taskBranchContent },
      conflictResolution: { path: "README.md", content: scriptedResolution },
      resolveConflicts: true,
    };
    await context.harness.store.updateSettings({ autoMerge: false });
    let taskWorktree: string | undefined;
    /*
    FNXC:PipelineSmoke 2026-08-23-21:45:
    This is a bounded sequence of explicit graph dispatches, not wall-clock polling. S13 pauses
    automatic merge only until the real executor commits its conflicting README.md, then restores
    normal admission before the integration-side write and merger run.
    */
    for (let turn = 0; turn < 8; turn += 1) {
      await context.harness.runProductionTurn(task.id, behavior);
      const current = await context.harness.freshTask(task.id);
      if (current.worktree && existsSync(join(current.worktree, "README.md"))
        && readFileSync(join(current.worktree, "README.md"), "utf8") === taskBranchContent) {
        taskWorktree = current.worktree;
        break;
      }
    }
    if (!taskWorktree) {
      throw new Error("S13 executor did not commit the conflict candidate on its real task branch.");
    }
    context.harness.fixture.seedFile("README.md", "# integration branch conflict\n");
    context.harness.fixture.git(["add", "README.md"]);
    context.harness.fixture.git(["commit", "-m", "main conflict fixture"]);
    await context.harness.store.updateSettings({ autoMerge: true });
    await driveMerged(context, behavior);
    if (readFileSync(join(context.harness.fixture.repoDir, "README.md"), "utf8") !== scriptedResolution) {
      throw new Error("S13 landed tree does not contain the scripted conflict resolution.");
    }
  }),

  s14Arrange: driver("create the declared no-commit task", async (context) => {
    await arrangeTask(context, "S14", { codeReview: false, noCommitsExpected: true });
  }),
  s14Act: driver("observe no-op merge on that arranged task", async (context) => {
    context.result = await context.harness.runNoOpScenario(taskFor(context).id);
  }),

  s15Arrange: driver("create a task while automatic merge is disabled", async (context) => {
    await arrangeTask(context, "S15");
  }),
  s15Act: driver("drive real workflow stages into the manual hold", async (context) => {
    const task = taskFor(context);
    await driveReviewedManualHold(context);
    context.result = await context.harness.assertTerminal(task.id, "manual-hold");
  }),
  s15Recovery: driver("release the production manual merge hold", async (context) => {
    const held = context.result;
    await releaseManualMerge(context);
    context.result = held;
  }),

  s16Arrange: driver("create the exact task that will receive stale-finalization state", async (context) => {
    await arrangeTask(context, "S16", { codeReview: false });
  }),
  s16Act: driver("reconcile stale finalization on that arranged task", async (context) => {
    context.result = await context.harness.runStaleFinalizationScenario(taskFor(context));
  }),

  s17Arrange: driver("create a restart candidate at its declared production boundary", async (context) => {
    const task = await arrangeTask(context, `S17-${context.variant ?? "planning"}`);
    if (context.variant === "execution") await context.harness.runProductionTurn(task.id);
    if (context.variant === "review" || context.variant === "merge-in-flight") await driveReviewedManualHold(context);
  }),
  s17Act: driver("restart a fresh engine and resume the recorded production boundary", async (context) => {
    const task = taskFor(context);
    if (context.variant === "post-merge") {
      context.result = await context.harness.restartPostMergeFinalization(task);
      return;
    }

    if (context.variant === "merge-in-flight") {
      await context.harness.store.updateSettings({ autoMerge: true });
      const beforeIntegration = await context.harness.integrationSha();
      const beforeWorkItems = await context.harness.workflowWorkItemSignature(task.id);
      const beforeAudits = await context.harness.store.getRunAuditEventsAsync({ taskId: task.id });
      let interruptMerge: ((error: Error) => void) | undefined;
      let enteredMerge: (() => void) | undefined;
      const interrupted = new Promise<void>((_resolve, reject) => { interruptMerge = reject; });
      const entered = new Promise<void>((resolve) => { enteredMerge = resolve; });
      const pending = context.harness.admitAndMerge(task.id, {
        manual: true,
        behavior: { waitForMerge: interrupted, onMergeEntered: () => enteredMerge?.() },
      });
      await entered;
      const boundary = await context.harness.freshTask(task.id);
      if (
        boundary.status !== "merging"
        || context.harness.engine.getActiveMergeTaskId() !== task.id
        || activeSessionRegistry.pathsForTask(task.id).length === 0
      ) {
        throw new Error("S17 did not reach a durable, live merge-in-flight production boundary.");
      }
      const restarted = await context.harness.restartComposition(task.id, { restartEngine: true });
      interruptMerge?.(new Error("pipeline merge body interrupted by restart"));
      const interruptedOutcome = await pending;
      if (!interruptedOutcome.error || (await context.harness.integrationSha()) !== beforeIntegration) {
        throw new Error("S17 restart allowed its interrupted merge body to land.");
      }
      const resumed = await context.harness.admitAndMerge(task.id, { manual: true });
      if (!resumed.result?.merged) throw resumed.error ?? new Error("S17 fresh engine did not resume its merge boundary.");
      context.result = await context.harness.assertTerminal(task.id, "merged-done");
      const landedAudits = await context.harness.store.getRunAuditEventsAsync({ taskId: task.id });
      if (
        landedAudits.filter((event) => event.mutationType === "merge:ai-landed").length
          !== beforeAudits.filter((event) => event.mutationType === "merge:ai-landed").length + 1
        || await context.harness.workflowWorkItemSignature(task.id) !== restarted.workItemSignatureAfter
        || beforeWorkItems !== restarted.workItemSignatureBefore
      ) {
        throw new Error("S17 merge-in-flight restart replayed a completed workflow seam.");
      }
      return;
    }

    await context.harness.restartComposition(task.id);
    if (context.variant === "review") {
      await releaseManualMerge(context);
      return;
    }
    await driveMerged(context);
  }),

  s18Arrange: driver("create a provider-failure candidate", async (context) => {
    await arrangeTask(context, "S18");
  }),
  s18Act: driver("park an actual scripted provider failure", async (context) => {
    const task = taskFor(context);
    for (let turn = 0; turn < 3; turn += 1) {
      await context.harness.runProductionTurn(task.id, { planReviewModes: ["provider-error"] });
      const live = await context.harness.freshTask(task.id);
      if (live.workflowStepResults?.some((result) => result.workflowStepId === "plan-review" && result.status === "failed")) {
        context.result = await context.harness.assertTerminal(task.id, "parked");
        return;
      }
    }
    throw new Error("S18 did not persist its provider-failure Plan Review row.");
  }),
  s18Recovery: driver("restore the mock provider and resume", async (context) => {
    const parked = context.result;
    await driveMerged(context, { planReviewModes: ["approve"], codeReviewModes: ["approve"] });
    context.result = parked;
  }),

  s19Arrange: driver("clone a built-in workflow with renamed column ids", async (context) => {
    const source = context.workflowId === "builtin:coding" ? "builtin:coding" : "builtin:coding-ideas-v2";
    const renamed = await context.harness.createRenamedWorkflow(source);
    context.workflowId = renamed.workflowId;
    await arrangeTask(context, `S19-${source}`);
  }),
  s19Act: driver("execute the cloned graph without legacy column ids", async (context) => {
    const task = taskFor(context);
    await driveMerged(context);
    const audits = await context.harness.store.getRunAuditEventsAsync({ taskId: task.id });
    const legacy = new Set(["ideas", "todo", "in-progress", "in-review", "done"]);
    const observedColumns = audits
      .filter((event) => event.mutationType === "task:column-transition")
      .flatMap((event) => [event.metadata?.fromColumn, event.metadata?.toColumn])
      .filter((column): column is string => typeof column === "string");
    if (observedColumns.some((column) => legacy.has(column))) {
      throw new Error("S19 observed a legacy column id on a renamed workflow.");
    }
  }),

  s21Arrange: driver("seed the MRG-058 verification interruption with five real commits", async (context) => {
    const task = await arrangeTask(context, "S21");
    await context.harness.arrangeExternalBlockReplay(task);
  }),
  s21Act: driver("drive scheduler and recovery while retaining the frozen work", async (context) => {
    const task = taskFor(context);
    for (let iteration = 0; iteration < 3; iteration += 1) {
      await context.harness.driveExternalBlockRecoveryCycles(task.id, { startup: iteration === 0 });
      await context.harness.assertExternalBlockReplay(task, "blocked");
    }
    context.result = await context.harness.assertTerminal(task.id, "blocked");
  }),
  s21Recovery: driver("invoke dashboard Retry and re-enter the interrupted verification node", async (context) => {
    const task = taskFor(context);
    await context.harness.resumeExternalBlockReplay(task.id);
    await context.harness.assertExternalBlockReplay(task, "resumed");
    context.result = await context.harness.assertTerminal(task.id, "parked");
  }),
} as const;
