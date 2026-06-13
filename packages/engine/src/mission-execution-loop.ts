/**
 * MissionExecutionLoop — Orchestrates the validation cycle for mission features.
 *
 * After a task completes, the loop:
 * 1. Transitions the feature from "implementing" to "validating"
 * 2. Runs an AI agent to evaluate the implementation against contract assertions
 * 3. Based on the validation result:
 *    - pass: marks feature as "passed", enables slice advancement
 *    - fail: creates a fix feature with failure context, decrements retry budget
 *    - blocked: marks feature as "blocked" (external blocker)
 *    - error: keeps feature in "validating" for retry
 */

import { EventEmitter } from "node:events";
import type {
  TaskStore,
  MissionStore,
  MissionContractAssertion,
  MissionFeature,
  MissionValidatorRun,
  AgentStore,
  Settings,
  Milestone,
} from "@fusion/core";
import { normalizeMissionAssertionType } from "@fusion/core";
import type { VerificationOutcome } from "./mission-verification.js";
import { createFnAgent, promptWithFallback, type AgentResult } from "./pi.js";
import { mergeEffectiveSettings } from "./effective-settings.js";
import {
  createResolvedAgentSession,
  extractRuntimeHint,
  resolveValidatorSessionModel,
} from "./agent-session-helpers.js";
import { createLogger } from "./logger.js";
import { createFallbackModelObserver } from "./fallback-model-observer.js";
import { createRunAuditor, generateSyntheticRunId } from "./run-audit.js";

/** Logger for the mission execution loop subsystem. */
export const loopLog = createLogger("mission-loop");

/** Maximum time (ms) to wait for a validation session to complete. */
const VALIDATION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Validation result returned by the AI agent.
 * The agent evaluates each linked assertion and returns pass/fail/blocked
 * per assertion plus an overall status.
 */
export interface ValidationResult {
  /**
   * Overall validation status.
   *
   * `inconclusive` is first-class and distinct from `fail`: it means a
   * behavioral verification run could not run or conclude (no isolating sandbox
   * backend, timeout, setup failure, rejected proof). In this unit it routes to
   * a blocked verdict (no remediation); later units track its infra-failure rate
   * separately.
   */
  status: "pass" | "fail" | "blocked" | "error" | "inconclusive";
  /** Per-assertion results */
  assertions: Array<{
    assertionId: string;
    passed: boolean;
    message?: string;
    expected?: string;
    actual?: string;
  }>;
  /** Summary message for overall result */
  summary: string;
  /** If blocked, the reason for the block */
  blockedReason?: string;
}

export interface MissionExecutionLoopOptions {
  /** Task store for accessing task data */
  taskStore: TaskStore;
  /** Mission store for accessing mission/feature data */
  missionStore: MissionStore;
  /** Optional MissionAutopilot for notifying on loop state changes */
  missionAutopilot?: {
    notifyValidationComplete?: (featureId: string, status: "passed" | "failed" | "blocked" | "error") => void | Promise<void>;
  };
  /** Root directory for worktree operations */
  rootDir: string;
  /** Maximum implementation retry budget (default: 3) */
  maxRetryBudget?: number;
  /** Plugin runner for runtime selection. When provided, enables plugin runtime lookup. */
  pluginRunner?: import("./plugin-runner.js").PluginRunner;
  /** Optional agent store for resolving assigned-agent runtime hints. */
  agentStore?: AgentStore;
  /**
   * Optional behavioral-verification capability (U3). When provided, behavioral
   * assertions are confirmed by a non-mutating verification run; the judge's
   * "pass" on a behavioral assertion is advisory only. When ABSENT, behavioral
   * assertions still default to fail (U2) but no verification run is attempted —
   * preserving the behavior of existing construction sites that inject nothing.
   */
  verificationCapability?: import("./mission-verification.js").VerificationCapability;
}

export class MissionExecutionLoop extends EventEmitter {
  private running = false;
  private taskStore: TaskStore;
  private missionStore: MissionStore;
  private rootDir: string;
  private maxRetryBudget: number;
  private missionAutopilot?: MissionExecutionLoopOptions["missionAutopilot"];
  private pluginRunner?: MissionExecutionLoopOptions["pluginRunner"];
  private agentStore?: MissionExecutionLoopOptions["agentStore"];
  private verificationCapability?: MissionExecutionLoopOptions["verificationCapability"];
  private activeValidations = new Set<string>(); // feature IDs currently being validated

  constructor(options: MissionExecutionLoopOptions) {
    super();
    this.taskStore = options.taskStore;
    this.missionStore = options.missionStore;
    this.rootDir = options.rootDir;
    this.maxRetryBudget = options.maxRetryBudget ?? 3;
    this.missionAutopilot = options.missionAutopilot;
    this.pluginRunner = options.pluginRunner;
    this.agentStore = options.agentStore;
    this.verificationCapability = options.verificationCapability;
    loopLog.log("MissionExecutionLoop created");
  }

  /**
   * Start the execution loop.
   * Currently a no-op since the loop is event-driven, but may be used
   * for future background processing.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    loopLog.log("MissionExecutionLoop started");
  }

  /**
   * Stop the execution loop.
   * Aborts any in-progress validations.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    // Abort any active validations
    for (const featureId of this.activeValidations) {
      loopLog.warn(`Aborting in-progress validation for feature ${featureId}`);
    }
    this.activeValidations.clear();
    loopLog.log("MissionExecutionLoop stopped");
  }

  /**
   * Check if the loop is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Reap validator runs that have been left in status='running' beyond the stale window.
   *
   * Runs still actively owned by this process are skipped so live validations are never
   * terminated by maintenance while their session is still in-flight.
   */
  async reapStaleValidatorRuns(maxAgeMs: number): Promise<{ reapedCount: number }> {
    const staleRuns = this.missionStore.listStaleRunningValidatorRuns(maxAgeMs);
    let reapedCount = 0;

    for (const run of staleRuns) {
      if (this.activeValidations.has(run.featureId)) {
        continue;
      }

      try {
        const reapedRun = this.missionStore.reapValidatorRun(
          run.id,
          `Validator run reaped after exceeding stale threshold (${maxAgeMs}ms) without a live owner.`,
        );
        reapedCount += 1;

        try {
          const milestone = this.missionStore.getMilestone(reapedRun.milestoneId);
          const missionId = milestone ? this.missionStore.getMission(milestone.missionId)?.id : undefined;
          const elapsedMs = Math.max(0, Date.now() - new Date(run.startedAt).getTime());
          this.taskStore.recordRunAuditEvent({
            agentId: "store",
            runId: "validator-run-reaper",
            domain: "database",
            mutationType: "mission:validator-run-reaped",
            target: reapedRun.id,
            metadata: {
              runId: reapedRun.id,
              featureId: reapedRun.featureId,
              missionId,
              triggerType: reapedRun.triggerType,
              elapsedMs,
            },
          });
        } catch (auditErr) {
          loopLog.warn(`Failed to record validator-run reaper audit for ${run.id}:`, auditErr);
        }
      } catch (err) {
        loopLog.warn(`Failed to reap stale validator run ${run.id}:`, err);
      }
    }

    return { reapedCount };
  }

  /**
   * Recover active missions on startup.
   *
   * Finds all features in "validating" or "needs_fix" state and re-enqueues
   * them for validation or fix implementation respectively.
   *
   * This handles the case where the engine was shut down mid-validation
   * or mid-fix, ensuring those features continue their loop progression.
   */
  async recoverActiveMissions(): Promise<{ recoveredCount: number }> {
    loopLog.log("Starting active mission recovery...");

    if (!this.running) {
      loopLog.warn("recoverActiveMissions called while loop is stopped; starting loop for recovery");
      this.start();
    }

    try {
      const missions = this.missionStore.listMissions();
      let recoveredCount = 0;

      for (const mission of missions) {
        if (mission.status !== "active") continue;

        let hierarchy;
        try {
          hierarchy = this.missionStore.getMissionWithHierarchy(mission.id);
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          loopLog.warn(`getMissionWithHierarchy failed for mission ${mission.id}: ${errorMessage} — skipping`);
          // Database error, skip this mission
          continue;
        }

        if (!hierarchy) continue;

        for (const milestone of hierarchy.milestones) {
          for (const slice of milestone.slices) {
            if (slice.status !== "active") continue;

            for (const feature of slice.features) {
              // Features in validating state need to be re-validated
              if (feature.loopState === "validating") {
                loopLog.log(`Recovery: re-queuing validating feature ${feature.id}`);
                // Transition back to implementing so the next task completion triggers validation
                try {
                  await this.missionStore.transitionLoopState(feature.id, "implementing");
                  // If the feature has a linked task that's already done, re-trigger validation
                  if (feature.taskId) {
                    const linkedTask = await this.taskStore.getTask(feature.taskId).catch(() => null);
                    if (linkedTask && (linkedTask.column === "done" || linkedTask.column === "archived")) {
                      await this.processTaskOutcome(feature.taskId);
                    }
                  }
                  recoveredCount++;
                } catch (err) {
                  loopLog.error(`Recovery failed for validating feature ${feature.id}:`, err);
                }
              }

              // Features in needs_fix state with completed tasks need to continue
              if (feature.loopState === "needs_fix") {
                loopLog.log(`Recovery: feature ${feature.id} awaiting fix implementation`);
                // If the fix task is complete, call processTaskOutcome to continue the cycle
                if (feature.taskId) {
                  try {
                    const linkedTask = await this.taskStore.getTask(feature.taskId).catch(() => null);
                    if (linkedTask && (linkedTask.column === "done" || linkedTask.column === "archived")) {
                      await this.processTaskOutcome(feature.taskId);
                    }
                    recoveredCount++;
                  } catch (err) {
                    loopLog.error(`Recovery failed for needs_fix feature ${feature.id}:`, err);
                  }
                } else {
                  recoveredCount++;
                }
              }

              // Features that remained implementing while their linked task already finished
              // can be stranded after restart; recover by re-triggering task outcome.
              if (feature.loopState === "implementing" && feature.taskId) {
                const currentFeature = this.missionStore.getFeature(feature.id) ?? feature;
                if (
                  this.activeValidations.has(feature.id)
                  || currentFeature.loopState === "passed"
                  || currentFeature.lastValidatorStatus === "passed"
                ) {
                  continue;
                }

                try {
                  const linkedTask = await this.taskStore.getTask(feature.taskId).catch(() => null);
                  if (linkedTask && (linkedTask.column === "done" || linkedTask.column === "archived")) {
                    loopLog.log(`Recovery: re-triggering implementing feature ${feature.id} from completed task ${feature.taskId}`);
                    await this.processTaskOutcome(feature.taskId);
                    recoveredCount++;
                  }
                } catch (err) {
                  loopLog.error(`Recovery failed for implementing feature ${feature.id}:`, err);
                }
              }

              // Features marked "done" but stranded with no linked task can never
              // validate on their own: the branches above only re-drive features
              // that still carry a taskId. Meanwhile the slice-completion gate
              // (MissionStore.computeSliceStatus) refuses to count an
              // assertion-linked "done" feature until its validator passes — so
              // the slice, milestone, and mission can never auto-progress.
              //
              // Several ways a task-less done feature lands stranded here:
              //   1. loopState="implementing" + null lastValidatorStatus — the
              //      original stranded-orphan case (FN-5715 / the autopilot-stall
              //      learning): validation was never driven.
              //   2. loopState="validating" + null lastValidatorStatus — a
              //      *reaped* run. `startValidatorRun` flips the feature to
              //      "validating"; `MissionStore.reapValidatorRun` resolves the
              //      stale run to status="error" but, by design, leaves a *done*
              //      feature's loopState untouched (its `shouldUpdateFeature`
              //      guard skips done features). So a reaped validation-only
              //      feature (no board task) is left "validating" forever: the
              //      "validating" branch above only re-drives features that carry
              //      a taskId, and `computeSliceStatus` never counts a "validating"
              //      done feature — the U7 reaper→slice deadlock (P0).
              //   3. loopState="needs_fix" + lastValidatorStatus="error" — a
              //      reaped run on a *non-done* feature that later moved to done,
              //      or a reaped manual run; "error" is likewise never accepted by
              //      computeSliceStatus and the needs_fix branch above only
              //      re-drives features with a taskId.
              //
              // The common shape is: a task-less, done, assertion-linked feature
              // that has not reached a *passed* validator status and is not
              // currently being validated. Re-drive it directly regardless of the
              // exact stranded loopState so it reaches a terminal verdict instead
              // of livelocking on "validating"/"error".
              //
              // Validation is bounded (verification wall-clock is provably under
              // the reaper stale window — see VALIDATOR_RUN_STALE_MAX_AGE_MS vs the
              // aggregate verification timeout) and non-mutating: on pass the
              // feature becomes legitimately complete; on fail the normal
              // fix-feature flow takes over; on inconclusive it routes to
              // needs-attention without minting remediation. Either way the
              // feature reaches a terminal verdict rather than re-driving forever.
              if (
                (feature.loopState === "implementing"
                  || feature.loopState === "validating"
                  || (feature.loopState === "needs_fix" && feature.lastValidatorStatus === "error"))
                && !feature.taskId
                && feature.status === "done"
                && feature.lastValidatorStatus !== "passed"
                && !this.activeValidations.has(feature.id)
              ) {
                const currentFeature = this.missionStore.getFeature(feature.id) ?? feature;
                if (
                  currentFeature.loopState === "passed"
                  || currentFeature.lastValidatorStatus === "passed"
                  || this.activeValidations.has(feature.id)
                ) {
                  continue;
                }
                try {
                  loopLog.warn(
                    `Recovery: re-validating stranded "done" feature ${feature.id} `
                    + `(loopState=${feature.loopState}, no linked task) so its slice can complete`,
                  );
                  recoveredCount++;
                  await this.runFeatureValidation(currentFeature);
                } catch (err) {
                  loopLog.error(`Recovery failed for stranded done feature ${feature.id}:`, err);
                }
              }
            }
          }
        }
      }

      loopLog.log(`Active mission recovery complete: recovered ${recoveredCount} features`);
      return { recoveredCount };
    } catch (err) {
      loopLog.error("Error during active mission recovery:", err);
      return { recoveredCount: 0 };
    }
  }

  /**
   * Process the outcome of a completed mission-linked task.
   *
   * Called by the Scheduler when a task with a sliceId moves to "done".
   * Triggers the validation cycle for the linked feature.
   *
   * @param taskId - The completed task ID
   */
  async processTaskOutcome(taskId: string): Promise<void> {
    if (!this.running) {
      loopLog.warn(`processTaskOutcome called but loop is not running; ignoring ${taskId}`);
      return;
    }

    loopLog.log(`Processing task outcome for ${taskId}`);


    try {
      // Find the feature linked to this task
      const feature = this.missionStore.getFeatureByTaskId(taskId);
      if (!feature) {
        loopLog.log(`Task ${taskId} has no linked feature; skipping validation`);
        return;
      }

      if (feature.loopState === "needs_fix") {
        this.missionStore.transitionLoopState(feature.id, "implementing");
        feature.loopState = "implementing";
      }

      // Only validate features in "implementing" state
      if (feature.loopState !== "implementing") {
        loopLog.log(`Feature ${feature.id} loopState is "${feature.loopState}"; skipping validation`);
        this.logFeatureWarningEvent(feature.id, "validation_skipped_loop_state", `Validation skipped: feature ${feature.id} is in loopState "${feature.loopState}" (expected "implementing").`, {
          taskId,
          loopState: feature.loopState,
        });
        return;
      }

      if (this.activeValidations.has(feature.id)) {
        loopLog.log(`Feature ${feature.id} already has an active validation; skipping duplicate trigger`);
        this.logFeatureWarningEvent(feature.id, "validation_deduplicated", `Validation already running for feature ${feature.id}; duplicate trigger ignored.`, {
          taskId,
        });
        return;
      }

      await this.runFeatureValidation(feature);
    } catch (err) {
      loopLog.error(`Error processing task outcome for ${taskId}:`, err);
      // Don't crash the loop - log and continue
    }
  }

  /**
   * Run assertion validation for a feature and apply the outcome.
   *
   * Shared by processTaskOutcome (task-triggered) and recoverActiveMissions
   * (self-healing for features stranded mid-loop with no board task). Callers
   * are responsible for confirming the feature is eligible to validate; this
   * method handles lazy assertion linkage, validator run bookkeeping, and
   * dispatch of the validation result.
   */
  private async runFeatureValidation(feature: MissionFeature): Promise<void> {
    // Lazily guarantee a linked assertion before validation so every feature
    // is evaluated by the validator even when legacy data is missing links.
    let assertions = this.missionStore.listAssertionsForFeature(feature.id);
    if (assertions.length === 0) {
      loopLog.log(`Feature ${feature.id} has no linked assertions; lazily ensuring store-managed assertion linkage`);
      assertions = this.missionStore.ensureFeatureAssertionLinked(feature.id);
    }

    // Mark feature as being validated
    this.activeValidations.add(feature.id);

    try {
      loopLog.log(`Running internal validation for feature ${feature.id} — no board task created (policy: docs/missions.md)`);

      // Start the validator run (no board task per docs/missions.md)
      const run = this.missionStore.startValidatorRun(feature.id, "task_completion");
      loopLog.log(`Started validator run ${run.id} for feature ${feature.id}`);

      // Run the validation
      const result = await this.runValidation(feature, assertions, run);

      // Handle the result
      if (result.status === "pass") {
        await this.handleValidationPass(feature.id, run.id, result.summary);
      } else if (result.status === "fail") {
        await this.handleValidationFail(feature.id, run.id, result);
      } else if (result.status === "inconclusive") {
        // R21 — "verification could not run" is distinct from "behavior observed
        // wrong". An infra-driven inconclusive (no isolating backend, timeout,
        // isolation setup failure, rejected proof) routes to a blocked/needs-
        // attention outcome that spawns NO Fix Feature, and is tracked with a
        // distinguishable infra-failure event so it is separable from real fails.
        await this.handleValidationInconclusive(feature.id, run.id, result.blockedReason ?? result.summary);
      } else if (result.status === "blocked") {
        await this.handleValidationBlocked(feature.id, run.id, result.blockedReason ?? result.summary);
      } else if (result.status === "error") {
        await this.handleValidationError(feature.id, run.id, result.summary);
      }
    } finally {
      this.activeValidations.delete(feature.id);
    }
  }

  /**
   * Run the validation AI session for a feature.
   *
   * Creates a fresh AI agent session with a validation system prompt,
   * evaluates the implementation against the linked assertions, and
   * returns the structured validation result.
   */
  private async runValidation(
    feature: MissionFeature,
    assertions: MissionContractAssertion[],
    _run: MissionValidatorRun,
  ): Promise<ValidationResult> {
    loopLog.log(`Running validation for feature ${feature.id} with ${assertions.length} assertions`);

    const milestone = this.resolveFeatureMilestone(feature);

    // Build the validation prompt
    const prompt = this.buildValidationPrompt(feature, assertions, milestone);

    // Get task context for validation
    const task = feature.taskId ? await this.taskStore.getTask(feature.taskId) : null;
    const taskContext = task ? this.buildTaskContext(task) : "";
    const assignedAgent = task?.assignedAgentId && this.agentStore
      ? await this.agentStore.getAgent(task.assignedAgentId).catch(() => null)
      : null;
    const validationRuntimeHint = extractRuntimeHint(assignedAgent?.runtimeConfig);
    // Merge per-task effective workflow settings (U3, KTD-3) so the validator
    // model-lane reads pick up workflow values; skip when there is no task in
    // scope (mission-level validation has no per-task workflow). Behavior-inert by
    // default.
    const baseSettings = await this.taskStore.getSettings().catch(() => undefined);
    const settings = task && baseSettings
      ? await mergeEffectiveSettings(this.taskStore, task, baseSettings)
      : baseSettings;
    const validationSessionModel = this.resolveValidationSessionModel(
      task,
      settings,
      assignedAgent?.runtimeConfig,
    );

    let session: AgentResult | null = null;

    try {
      // Create validation agent session
      const runAuditor = createRunAuditor(this.taskStore, {
        runId: generateSyntheticRunId("mission", feature.taskId ?? feature.id),
        agentId: "reviewer",
        taskId: task?.id,
        phase: "mission",
        source: "mission-execution-loop",
      });
      const sessionResult = await createResolvedAgentSession({
        sessionPurpose: "validation",
        runtimeHint: validationRuntimeHint,
        pluginRunner: this.pluginRunner,
        cwd: this.rootDir,
        systemPrompt: this.buildValidationSystemPrompt(feature, assertions, taskContext, milestone),
        tools: "readonly",
        defaultProvider: validationSessionModel.provider,
        defaultModelId: validationSessionModel.modelId,
        fallbackProvider: settings?.fallbackProvider,
        fallbackModelId: settings?.fallbackModelId,
        defaultThinkingLevel: "medium",
        runAuditor,
        settings,
        onText: (_delta) => {
          // Could stream this to a log entry if needed
        },
        taskId: task?.id,
        taskTitle: task?.title,
        onFallbackModelUsed: createFallbackModelObserver({
          agent: "reviewer",
          label: "mission validator",
          store: this.taskStore,
          taskId: task?.id,
          taskTitle: task?.title,
        }),
      });
      session = { session: sessionResult.session, sessionFile: sessionResult.sessionFile };

      loopLog.log(`Validation session created for feature ${feature.id}`);

      // Run the validation with timeout
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error("Validation timeout")), VALIDATION_TIMEOUT_MS);
      });

      const validationPromise = this.runValidationSession(session.session, prompt);

      try {
        await Promise.race([validationPromise, timeoutPromise]);
      } finally {
        // Always clear the timer so it does not stay armed across validations.
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }

      // Get the validation result from the session
      // The agent should have returned structured JSON in its response
      const judgeResult = await this.parseValidationResult(session.session, assertions);

      // U2/U3: the read-only judge's verdict is authoritative for STATIC
      // assertions only. BEHAVIORAL assertions default to fail and are confirmed
      // (or refuted) by a non-mutating verification run instead.
      const result = await this.applyBehavioralPosture(feature, assertions, judgeResult);

      loopLog.log(`Validation completed for feature ${feature.id}: ${result.status}`);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      loopLog.error(`Validation error for feature ${feature.id}:`, message);

      // Return an error result - the loop will handle it
      return {
        status: "error",
        assertions: assertions.map((a) => ({
          assertionId: a.id,
          passed: false,
          message: `Validation error: ${message}`,
        })),
        summary: `Validation failed due to error: ${message}`,
      };
    } finally {
      // Always dispose the session
      if (session) {
        try {
          session.session.dispose();
          loopLog.log(`Validation session disposed for feature ${feature.id}`);
        } catch (disposeErr) {
          loopLog.warn(`Error disposing validation session for ${feature.id}:`, disposeErr);
        }
      }
    }
  }

  /**
   * Apply the behavioral judging posture (U2/U3) to the read-only judge's
   * verdict.
   *
   * - STATIC assertions keep the judge's verdict verbatim (no behavior change).
   * - BEHAVIORAL assertions DEFAULT TO FAIL. The judge's "pass" on a behavioral
   *   assertion is advisory; an authoritative pass requires a verification run
   *   to confirm it. When a verification capability is injected, each behavioral
   *   assertion is run through it: pass → satisfied; fail → behavioral failure;
   *   inconclusive → the aggregate becomes inconclusive (infra, no remediation).
   *   When NO capability is injected, behavioral assertions simply stay failed
   *   (preserving existing call-site behavior — existing data is all static).
   *
   * The aggregate status is recomputed from the post-posture per-assertion
   * results so the existing pass/fail/blocked/error/inconclusive flow is driven
   * correctly.
   */
  private async applyBehavioralPosture(
    feature: MissionFeature,
    assertions: MissionContractAssertion[],
    judgeResult: ValidationResult,
  ): Promise<ValidationResult> {
    // Preserve non-behavioral terminal verdicts untouched (error/blocked from the
    // judge are not behavioral posture concerns). A "blocked" verdict must short-
    // circuit too: otherwise it falls through to the aggregate recompute below,
    // which would rewrite it to "fail" and incorrectly route to a Fix Feature
    // instead of handleValidationBlocked.
    if (judgeResult.status === "error" || judgeResult.status === "blocked") {
      return judgeResult;
    }

    const typeById = new Map<string, ReturnType<typeof normalizeMissionAssertionType>>();
    let hasBehavioral = false;
    for (const a of assertions) {
      const t = normalizeMissionAssertionType(a.type);
      typeById.set(a.id, t);
      if (t === "behavioral") hasBehavioral = true;
    }

    // Fast path: no behavioral assertions → existing static path is preserved
    // exactly. This keeps every existing (untyped/static) test green.
    if (!hasBehavioral) {
      return judgeResult;
    }

    const textById = new Map(assertions.map((a) => [a.id, a.assertion]));
    let sawInconclusive = false;
    let inconclusiveReason: string | undefined;

    const newAssertionResults = await Promise.all(
      judgeResult.assertions.map(async (judged) => {
        const type = typeById.get(judged.assertionId) ?? "static";
        if (type !== "behavioral") {
          // Static: keep judge verdict verbatim.
          return judged;
        }

        // Behavioral: default to fail unless verification confirms it.
        if (!this.verificationCapability) {
          return {
            ...judged,
            passed: false,
            message: "Behavioral assertion defaults to fail: no verification evidence (advisory judge verdict is not authoritative).",
            expected: judged.expected ?? "Behavior confirmed by a verification run",
            actual: judged.actual ?? "No verification run was performed",
          };
        }

        let outcome: VerificationOutcome;
        try {
          outcome = await this.verificationCapability.verifyBehavioralAssertion({
            assertionId: judged.assertionId,
            assertion: textById.get(judged.assertionId) ?? "",
            taskId: feature.taskId,
            integrationSha: await this.resolveIntegrationSha(feature),
            signal: undefined,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          loopLog.warn(`Verification capability threw for assertion ${judged.assertionId}: ${message}`);
          outcome = { verdict: "inconclusive", assertionId: judged.assertionId, reason: `verification error: ${message}` };
        }

        if (outcome.verdict === "pass") {
          return { ...judged, passed: true, message: outcome.reason };
        }
        if (outcome.verdict === "inconclusive") {
          sawInconclusive = true;
          inconclusiveReason = inconclusiveReason ?? outcome.reason;
          return {
            ...judged,
            passed: false,
            message: `Behavioral verification inconclusive: ${outcome.reason}`,
            expected: judged.expected ?? "Behavior confirmed by a verification run",
            actual: outcome.detail ?? "Verification could not conclude",
          };
        }
        // fail
        return {
          ...judged,
          passed: false,
          message: outcome.reason,
          expected: judged.expected ?? "Behavior confirmed by a verification run",
          actual: outcome.detail ?? judged.actual ?? "Behavior not confirmed",
        };
      }),
    );

    const allPassed = newAssertionResults.every((a) => a.passed);

    // Inconclusive takes precedence over fail: an infra-driven non-pass must not
    // be mistaken for an observed behavioral failure (no Fix Feature).
    let status: ValidationResult["status"];
    if (sawInconclusive && !allPassed) {
      status = "inconclusive";
    } else if (allPassed) {
      status = "pass";
    } else {
      status = "fail";
    }

    const summary = status === "pass"
      ? judgeResult.summary
      : status === "inconclusive"
        ? `Behavioral verification inconclusive: ${inconclusiveReason ?? "verification could not conclude"}`
        : "One or more behavioral assertions were not confirmed by verification.";

    return {
      status,
      assertions: newAssertionResults,
      summary,
      blockedReason: status === "inconclusive" ? (inconclusiveReason ?? "verification inconclusive") : judgeResult.blockedReason,
    };
  }

  /**
   * Resolve the trusted revision (integration SHA) whose disposable checkout the
   * verification run executes against. The live task worktree is pruned before
   * the done-transition that triggers validation, so it cannot be used.
   *
   * In this unit we read it from the linked task when available; callers that do
   * not supply a resolvable SHA cause the verification run to resolve to
   * inconclusive (fail-closed). A richer derivation is owned by a later unit.
   */
  private async resolveIntegrationSha(feature: MissionFeature): Promise<string | undefined> {
    if (!feature.taskId) return undefined;
    try {
      const task = await this.taskStore.getTask(feature.taskId);
      const candidate = (task as { integrationSha?: string; baseCommit?: string } | undefined);
      return candidate?.integrationSha ?? candidate?.baseCommit ?? undefined;
    } catch {
      return undefined;
    }
  }

  private resolveValidationSessionModel(
    task: Awaited<ReturnType<TaskStore["getTask"]>> | null,
    settings: Partial<Settings> | undefined,
    assignedAgentRuntimeConfig?: Record<string, unknown>,
  ): { provider: string | undefined; modelId: string | undefined } {
    return resolveValidatorSessionModel(
      task?.validatorModelProvider,
      task?.validatorModelId,
      settings,
      assignedAgentRuntimeConfig,
    );
  }

  /**
   * Run the actual validation session with the AI agent.
   */
  private async runValidationSession(
    agentSession: Awaited<ReturnType<typeof createFnAgent>>["session"],
    prompt: string,
  ): Promise<void> {
    // Use promptWithFallback for resilience - if the primary model fails,
    // it will automatically try the fallback model
    await promptWithFallback(
      agentSession as Parameters<typeof promptWithFallback>[0],
      prompt,
    );
  }

  /**
   * Parse the validation result from the AI agent's response.
   *
   * The agent is expected to return structured JSON with the validation result.
   * We extract the text from the AI's messages and parse the JSON response.
   */
  private async parseValidationResult(
    agentSession: Awaited<ReturnType<typeof createFnAgent>>["session"],
    assertions: MissionContractAssertion[],
  ): Promise<ValidationResult> {
    try {
      // Extract the AI's response text from the session messages
      const responseText = this.extractResponseTextFromSession(agentSession);

      if (!responseText) {
        loopLog.warn("No response text found in validation session");
        return this.createErrorValidationResult("No response from validation agent", assertions);
      }

      // Extract JSON from the response (handles markdown code blocks)
      const jsonCandidate = this.extractJsonCandidate(responseText);

      if (!jsonCandidate) {
        loopLog.warn("No JSON found in validation response");
        return this.createErrorValidationResult("Validation agent did not return JSON", assertions);
      }

      // Try to parse the JSON
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(jsonCandidate);
      } catch {
        // Intentional fallback: initial parse can fail on malformed JSON; try repairJson() next.
        const repaired = this.repairJson(jsonCandidate);
        try {
          parsed = JSON.parse(repaired);
        } catch (e) {
          loopLog.warn("Failed to parse validation JSON", e);
          return this.createErrorValidationResult("Invalid JSON in validation response", assertions);
        }
      }

      // Validate the status field
      const status = this.validateValidationStatus(parsed.status);
      if (!status) {
        loopLog.warn("Invalid validation status in response", parsed.status);
        return this.createErrorValidationResult("Invalid status in validation response", assertions);
      }

      // Extract assertion results from the parsed JSON
      const assertionResults = this.extractAssertionResults(parsed, assertions);

      // Extract summary and blocked reason
      const summary = typeof parsed.summary === "string" ? parsed.summary : `Validation ${status}`;
      const blockedReason = typeof parsed.blockedReason === "string" ? parsed.blockedReason : undefined;

      return {
        status,
        assertions: assertionResults,
        summary,
        blockedReason,
      };
    } catch (err) {
      loopLog.error("Error parsing validation result", err);
      return this.createErrorValidationResult(`Error parsing validation: ${err}`, assertions);
    }
  }

  /**
   * Extract response text from AI session messages.
   * Looks for the last assistant message with text content.
   */
  private extractResponseTextFromSession(
    agentSession: Awaited<ReturnType<typeof createFnAgent>>["session"],
  ): string | undefined {
    try {
      // Access the session state to get messages
      const state = (agentSession as { state?: { messages?: Array<{ role?: string; content?: unknown }> } }).state;
      if (!state?.messages) {
        return undefined;
      }

      // Find the last assistant message with text content
      for (let i = state.messages.length - 1; i >= 0; i--) {
        const msg = state.messages[i];
        if (msg.role === "assistant") {
          if (typeof msg.content === "string" && msg.content.trim()) {
            return msg.content;
          }
          // Handle content as array (common in some AI SDKs)
          if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string") {
                return part.text;
              }
            }
          }
        }
      }

      return undefined;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      loopLog.warn(`AI response JSON extraction failed: ${errorMessage}`);
      return undefined;
    }
  }

  /**
   * Extract JSON from a text that may contain markdown code blocks.
   */
  private extractJsonCandidate(text: string): string | undefined {
    // Try to find JSON in markdown code blocks first
    const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (codeBlockMatch) {
      return codeBlockMatch[1].trim();
    }

    // Try to find JSON directly (starts with { or [)
    const jsonStartMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (jsonStartMatch) {
      return jsonStartMatch[1];
    }

    return undefined;
  }

  /**
   * Repair common JSON issues in AI responses.
   */
  private repairJson(json: string): string {
    // Remove trailing commas before closing braces/brackets
    let repaired = json.replace(/,\s*([\]}])/g, "$1");

    // Handle unclosed arrays/objects by finding the last balanced close
    const openBraces = (repaired.match(/\{/g) || []).length;
    const closeBraces = (repaired.match(/\}/g) || []).length;
    const openBrackets = (repaired.match(/\[/g) || []).length;
    const closeBrackets = (repaired.match(/\]/g) || []).length;

    // Close missing braces
    while (closeBraces < openBraces) {
      repaired += "}";
    }
    // Close missing brackets
    while (closeBrackets < openBrackets) {
      repaired += "]";
    }

    // Remove any trailing commas
    repaired = repaired.replace(/,\s*([\]}])/g, "$1");

    return repaired;
  }

  /**
   * Validate that the status field is a valid validation status.
   */
  private validateValidationStatus(status: unknown): ValidationResult["status"] | undefined {
    if (status === "pass" || status === "fail" || status === "blocked") {
      return status;
    }
    return undefined;
  }

  /**
   * Extract assertion results from the parsed JSON.
   */
  private extractAssertionResults(
    parsed: Record<string, unknown>,
    assertions: MissionContractAssertion[],
  ): Array<{ assertionId: string; passed: boolean; message?: string; expected?: string; actual?: string }> {
    const results: Array<{
      assertionId: string;
      passed: boolean;
      message?: string;
      expected?: string;
      actual?: string;
    }> = [];

    // If assertions array is provided in the response, use it
    if (Array.isArray(parsed.assertions)) {
      for (const item of parsed.assertions) {
        if (typeof item === "object" && item !== null) {
          const assertionItem = item as Record<string, unknown>;
          const assertionId =
            typeof assertionItem.assertionId === "string"
              ? assertionItem.assertionId
              : typeof assertionItem.id === "string"
                ? assertionItem.id
                : undefined;

          const passed = typeof assertionItem.passed === "boolean" ? assertionItem.passed : false;

          results.push({
            assertionId: assertionId || "unknown",
            passed,
            message: typeof assertionItem.message === "string" ? assertionItem.message : undefined,
            expected: typeof assertionItem.expected === "string" ? assertionItem.expected : undefined,
            actual: typeof assertionItem.actual === "string" ? assertionItem.actual : undefined,
          });
        }
      }
    }

    // Backfill any linked assertions the judge omitted from its response. A
    // partial judge response must not silently drop assertions: every linked
    // assertion needs a result so behavioral assertions still reach
    // verifyBehavioralAssertion and the aggregate is computed over the full set.
    if (assertions.length > 0) {
      const seen = new Set(results.map((r) => r.assertionId));
      const overallPassed = parsed.status === "pass";
      for (const assertion of assertions) {
        if (seen.has(assertion.id)) continue;
        results.push({
          assertionId: assertion.id,
          passed: overallPassed,
          message: overallPassed ? "Passed" : "Failed",
        });
      }
    }

    return results;
  }

  /**
   * Create an error validation result.
   */
  private createErrorValidationResult(
    errorMessage: string,
    assertions: MissionContractAssertion[],
  ): ValidationResult {
    return {
      status: "error",
      assertions: assertions.map((a) => ({
        assertionId: a.id,
        passed: false,
        message: errorMessage,
      })),
      summary: errorMessage,
    };
  }

  /**
   * Build the validation prompt sent to the AI agent.
   */
  private buildValidationPrompt(
    feature: MissionFeature,
    assertions: MissionContractAssertion[],
    milestone?: Milestone,
  ): string {
    const assertionTexts = assertions
      .map((a, i) => `${i + 1}. **${a.title}**: ${a.assertion}`)
      .join("\n");
    const milestoneAcceptanceCriteria = milestone?.acceptanceCriteria?.trim();
    const milestoneContext = milestoneAcceptanceCriteria
      ? `\nMilestone acceptance criteria (must also be satisfied for this feature to pass):\n${milestoneAcceptanceCriteria}\n`
      : "";

    return `Evaluate the implementation for feature "${feature.title}" against the following contract assertions:

${assertionTexts}${milestoneContext}
For each assertion:
- Determine if the implementation satisfies the assertion (pass/fail/blocked)
- If failed, explain what was expected vs what was actually observed
- If blocked, explain what external factor prevented validation
- Also verify that the implementation satisfies any milestone acceptance criteria provided above

Respond with a JSON object in this format:
{
  "status": "pass|fail|blocked",
  "assertions": [
    {
      "assertionId": "CA-...",
      "passed": true|false,
      "message": "Explanation if failed",
      "expected": "What was expected",
      "actual": "What was observed"
    }
  ],
  "summary": "Overall summary of validation",
  "blockedReason": "Reason if status is blocked"
}

Be thorough and objective. If any assertion fails, the overall status should be "fail".`;
  }

  /**
   * Build the system prompt for the validation agent.
   */
  private buildValidationSystemPrompt(
    _feature: MissionFeature,
    _assertions: MissionContractAssertion[],
    taskContext: string,
    milestone?: Milestone,
  ): string {
    const milestoneAcceptanceCriteria = milestone?.acceptanceCriteria?.trim();
    return `You are a validation agent responsible for evaluating whether an implementation satisfies its contract assertions.

You will receive:
1. A feature description with its acceptance criteria
2. Contract assertions to evaluate against
3. Task context including the implementation details${milestoneAcceptanceCriteria ? `\n4. Milestone acceptance criteria text that also applies to this feature: ${milestoneAcceptanceCriteria}` : ""}

Your job is to:
1. Carefully review the implementation as described in the task context
2. Evaluate each contract assertion objectively
3. Determine if the implementation fully satisfies each assertion
4. Verify the implementation also satisfies any milestone acceptance criteria provided for the parent milestone
5. Return a structured JSON response with your findings

Be thorough and precise. A contract assertion represents a commitment made during planning - the implementation must fully satisfy it or it is considered failed.

Evaluation guidance:
- "pass" means all required assertions are fully satisfied.
- "fail" means one or more assertions are unmet or only partially satisfied.
- "blocked" means you cannot evaluate due to missing/insufficient evidence or external constraints.
- Partial satisfaction must be marked as failed with clear expected vs actual details.
- Milestone acceptance criteria are validator-executed requirements, not informational context.

Response format: Return ONLY a JSON object (no additional text) with this structure:
{
  "status": "pass|fail|blocked",
  "assertions": [
    {
      "assertionId": "The assertion ID",
      "passed": true|false,
      "message": "Explanation of your evaluation",
      "expected": "What the assertion required",
      "actual": "What you observed in the implementation"
    }
  ],
  "summary": "A concise summary of your overall evaluation",
  "blockedReason": "If blocked, explain what external factor prevented validation"
}

${taskContext ? `\n\nImplementation context:\n${taskContext}` : ""}`;
  }

  /**
   * Build task context string for validation.
   */
  private buildTaskContext(task: { id: string; title?: string; description?: string; log?: Array<{ action?: string }> }): string {
    const lines: string[] = [];
    lines.push(`Task: ${task.title || task.id}`);
    if (task.description) {
      lines.push(`Description: ${task.description}`);
    }
    if (task.log && task.log.length > 0) {
      lines.push("\nRecent actions:");
      const recentLogs = task.log.slice(-10);
      for (const entry of recentLogs) {
        if (entry.action) {
          lines.push(`  - ${entry.action}`);
        }
      }
    }
    return lines.join("\n");
  }

  private resolveFeatureMilestone(feature: MissionFeature): Milestone | undefined {
    const slice = this.missionStore.getSlice(feature.sliceId);
    if (!slice) {
      return undefined;
    }

    return this.missionStore.getMilestone(slice.milestoneId);
  }

  private completeValidatorRunIfStillRunning(
    runId: string | undefined,
    status: "passed" | "failed" | "blocked" | "error",
    summaryOrReason?: string,
  ): boolean {
    if (!runId) {
      return false;
    }

    if (typeof this.missionStore.getValidatorRun !== "function") {
      this.missionStore.completeValidatorRun(runId, status, summaryOrReason);
      return true;
    }

    const run = this.missionStore.getValidatorRun(runId);
    if (!run || run.status !== "running") {
      loopLog.warn(`Validator run ${runId} is no longer running; skipping ${status} completion.`);
      return false;
    }

    this.missionStore.completeValidatorRun(runId, status, summaryOrReason);
    return true;
  }

  /**
   * Handle a successful validation (pass).
   */
  private async handleValidationPass(
    featureId: string,
    runId: string | undefined,
    summary: string,
  ): Promise<void> {
    try {
      this.completeValidatorRunIfStillRunning(runId, "passed", summary);

      const feature = this.missionStore.getFeature(featureId);
      if (feature && feature.status !== "done") {
        this.missionStore.updateFeatureStatus(featureId, "done");
      }

      loopLog.log(`Feature ${featureId} passed validation`);

      // Notify autopilot if configured
      if (this.missionAutopilot?.notifyValidationComplete) {
        await this.missionAutopilot.notifyValidationComplete(featureId, "passed");
      }

      this.emit("validation:passed", { featureId, runId, summary });
    } catch (err) {
      loopLog.error(`Error handling validation pass for ${featureId}:`, err);
    }
  }

  /**
   * Handle a failed validation.
   */
  private async handleValidationFail(
    featureId: string,
    runId: string | undefined,
    result: ValidationResult,
  ): Promise<void> {
    // Tracks how autopilot should be notified. A retry-budget-exhausted feature
    // transitions to blocked, so autopilot must be told "blocked" (not "failed")
    // to stay in sync with the validator-run state.
    let terminalStatus: "failed" | "blocked" = "failed";
    try {
      // Record the failures
      const failures = result.assertions
        .filter((a) => !a.passed)
        .map((a) => ({
          featureId,
          assertionId: a.assertionId,
          message: a.message || "Assertion failed",
          expected: a.expected,
          actual: a.actual,
        }));

      const canCompleteRun = runId
        ? typeof this.missionStore.getValidatorRun !== "function" || this.missionStore.getValidatorRun(runId)?.status === "running"
        : false;

      if (runId && failures.length > 0 && canCompleteRun) {
        this.missionStore.recordValidatorFailures(runId, failures);
      }

      this.completeValidatorRunIfStillRunning(runId, "failed", result.summary);

      loopLog.log(`Feature ${featureId} failed validation with ${failures.length} failures`);

      // R6 — build an observed-vs-expected reason so the remediation agent sees
      // what behavior was wrong, not just which assertion ids failed.
      const failureReason = this.buildFailureReason(failures, result.summary);

      // R16 — durable observability: a verification/validation failure is a
      // persisted mission event, not just a log line.
      this.logFeatureMissionEvent(featureId, "error", "validation_failed", `Validation failed for feature ${featureId}: ${result.summary}`, {
        runId: runId ?? null,
        failedAssertionIds: failures.map((f) => f.assertionId),
        reason: failureReason,
        outcome: "fail",
      });

      // Create fix feature
      try {
        const fixFeature = this.missionStore.createGeneratedFixFeature(
          featureId,
          runId || "unknown",
          failures.map((f) => f.assertionId),
          failureReason,
        );
        loopLog.log(`Created fix feature ${fixFeature.id} for ${featureId}`);

        // Auto-triage the fix feature so the retry loop can continue
        try {
          await this.missionStore.triageFeature(fixFeature.id);
          loopLog.log(`Auto-triaged fix feature ${fixFeature.id}`);
        } catch (triageErr) {
          const triageMessage = triageErr instanceof Error ? triageErr.message : String(triageErr);
          loopLog.error(`Error triaging fix feature ${fixFeature.id}:`, triageMessage);
          // R16 — a swallowed triage error must be durably recorded, not just
          // logged. The branch-group-collision learning: silent triage stalls
          // are invisible mission deadlocks. The Fix Feature was created and can
          // be triaged manually, so we continue, but the failure is persisted.
          this.logFeatureMissionEvent(featureId, "error", "fix_feature_triage_failed", `Auto-triage of fix feature ${fixFeature.id} failed: ${triageMessage}`, {
            runId: runId ?? null,
            fixFeatureId: fixFeature.id,
            error: triageMessage,
          });
        }

        this.emit("validation:failed", {
          featureId,
          runId,
          failures,
          fixFeatureId: fixFeature.id,
        });
      } catch (fixErr) {
        const message = fixErr instanceof Error ? fixErr.message : String(fixErr);
        if (message.includes("retry budget exhausted") || message.includes("exhausted its retry budget")) {
          loopLog.warn(`Feature ${featureId} retry budget exhausted; marking as blocked`);
          // completeValidatorRun already handles the blocked transition when budget is exhausted
          terminalStatus = "blocked";
          this.logFeatureMissionEvent(featureId, "error", "retry_budget_exhausted", `Feature ${featureId} exhausted its retry budget`, {
            runId: runId ?? null,
          });
          this.emit("validation:budget_exhausted", { featureId, runId });
        } else {
          loopLog.error(`Error creating fix feature for ${featureId}:`, message);
          // R16 — a swallowed Fix-Feature creation error is durably recorded.
          this.logFeatureMissionEvent(featureId, "error", "fix_feature_creation_failed", `Failed to create fix feature for ${featureId}: ${message}`, {
            runId: runId ?? null,
            error: message,
          });
        }
      }

      // Notify autopilot if configured
      if (this.missionAutopilot?.notifyValidationComplete) {
        await this.missionAutopilot.notifyValidationComplete(featureId, terminalStatus);
      }
    } catch (err) {
      loopLog.error(`Error handling validation fail for ${featureId}:`, err);
    }
  }

  /**
   * Build an observed-vs-expected failure reason (R6) suitable for surfacing to
   * the remediation agent in the generated Fix Feature. Prefers per-assertion
   * expected/actual detail; falls back to the per-assertion message, then the
   * overall summary.
   */
  private buildFailureReason(
    failures: Array<{ assertionId: string; message: string; expected?: string; actual?: string }>,
    summary: string,
  ): string {
    if (failures.length === 0) {
      return summary;
    }
    const lines = failures.map((f) => {
      const parts: string[] = [`- ${f.assertionId}: ${f.message}`];
      if (f.expected) parts.push(`    expected: ${f.expected}`);
      if (f.actual) parts.push(`    observed: ${f.actual}`);
      return parts.join("\n");
    });
    return lines.join("\n");
  }

  /**
   * Handle an inconclusive validation (R21).
   *
   * An inconclusive verdict means verification could not run or could not
   * conclude (no isolating sandbox backend, timeout, isolation setup failure,
   * rejected proof, detected flakiness) — it is NOT an observed behavioral
   * failure. It must:
   *   - route to a blocked/needs-attention outcome (no Fix Feature, no
   *     remediation work minted),
   *   - record a distinguishable, durably-observable infra-failure signal so the
   *     infra-failure rate is separable from real failures.
   *
   * The validator run is completed as `blocked` (no new run status is
   * introduced), but the persisted mission event carries a distinct
   * `verification_inconclusive` code and an `outcome: "inconclusive"` marker so
   * downstream observers can compute the infra-failure rate distinctly from real
   * fails (which carry `outcome: "fail"`).
   */
  private async handleValidationInconclusive(
    featureId: string,
    runId: string | undefined,
    reason: string | undefined,
  ): Promise<void> {
    try {
      this.completeValidatorRunIfStillRunning(runId, "blocked", reason);
      loopLog.warn(`Feature ${featureId} verification inconclusive: ${reason ?? "no reason provided"}`);

      // R16/R21 — durable, distinguishable infra-failure event. The `outcome`
      // marker separates infra-driven non-passes from real behavioral fails so
      // the infra-failure rate can be tracked without conflating the two.
      this.logFeatureMissionEvent(featureId, "warning", "verification_inconclusive", `Verification inconclusive for feature ${featureId}: ${reason ?? "verification could not conclude"}`, {
        runId: runId ?? null,
        reason: reason ?? null,
        outcome: "inconclusive",
        infraFailure: true,
      });

      // Explicitly does NOT call createGeneratedFixFeature — inconclusive mints
      // no remediation work (R21).

      if (this.missionAutopilot?.notifyValidationComplete) {
        await this.missionAutopilot.notifyValidationComplete(featureId, "blocked");
      }

      this.emit("validation:inconclusive", { featureId, runId, reason });
    } catch (err) {
      loopLog.error(`Error handling inconclusive validation for ${featureId}:`, err);
    }
  }

  /**
   * Handle a blocked validation.
   */
  private async handleValidationBlocked(
    featureId: string,
    runId: string | undefined,
    blockedReason: string | undefined,
  ): Promise<void> {
    try {
      this.completeValidatorRunIfStillRunning(runId, "blocked", blockedReason);
      loopLog.log(`Feature ${featureId} blocked: ${blockedReason}`);
      this.logFeatureErrorEvent(featureId, "validation_blocked", `Validation blocked for feature ${featureId}: ${blockedReason ?? "no reason provided"}`, {
        runId,
        blockedReason: blockedReason ?? null,
      });

      // Notify autopilot if configured
      if (this.missionAutopilot?.notifyValidationComplete) {
        await this.missionAutopilot.notifyValidationComplete(featureId, "blocked");
      }

      this.emit("validation:blocked", { featureId, runId, reason: blockedReason });
    } catch (err) {
      loopLog.error(`Error handling validation blocked for ${featureId}:`, err);
    }
  }

  /**
   * Handle a validation error (AI session failure, etc).
   */
  private async handleValidationError(
    featureId: string,
    runId: string | undefined,
    error: string,
  ): Promise<void> {
    try {
      this.completeValidatorRunIfStillRunning(runId, "error", error);
      loopLog.error(`Feature ${featureId} validation error: ${error}`);
      this.logFeatureErrorEvent(featureId, "validation_error", `Validation error for feature ${featureId}: ${error}`, {
        runId,
        error,
      });

      // Notify autopilot if configured
      if (this.missionAutopilot?.notifyValidationComplete) {
        await this.missionAutopilot.notifyValidationComplete(featureId, "error");
      }

      this.emit("validation:error", { featureId, runId, error });
    } catch (err) {
      loopLog.error(`Error handling validation error for ${featureId}:`, err);
    }
  }

  private logFeatureWarningEvent(
    featureId: string,
    code: string,
    description: string,
    metadata: Record<string, unknown>,
  ): void {
    this.logFeatureMissionEvent(featureId, "warning", code, description, metadata);
  }

  private logFeatureErrorEvent(
    featureId: string,
    code: string,
    description: string,
    metadata: Record<string, unknown>,
  ): void {
    this.logFeatureMissionEvent(featureId, "error", code, description, metadata);
  }

  private logFeatureMissionEvent(
    featureId: string,
    eventType: "warning" | "error",
    code: string,
    description: string,
    metadata: Record<string, unknown>,
  ): void {
    const feature = this.missionStore.getFeature(featureId);
    if (!feature) return;
    const slice = this.missionStore.getSlice(feature.sliceId);
    if (!slice) return;
    const milestone = this.missionStore.getMilestone(slice.milestoneId);
    if (!milestone) return;

    try {
      this.missionStore.logMissionEvent?.(milestone.missionId, eventType, description, {
        code,
        featureId,
        sliceId: slice.id,
        milestoneId: milestone.id,
        ...metadata,
      });
    } catch (err) {
      loopLog.warn(`Failed to log mission ${eventType} event for feature ${featureId}:`, err);
    }
  }
}
