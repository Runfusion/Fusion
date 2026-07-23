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
  AsyncMissionStore,
  MissionContractAssertion,
  MissionFeature,
  MissionValidatorRun,
  AgentStore,
  Settings,
  Milestone,
  Mission,
  ValidationDiagnostics,
} from "@fusion/core";
import { normalizeMissionAssertionType, normalizeValidationDiagnostics, renderValidationFailureDescription } from "@fusion/core";
import { GitCheckoutMaterializer, type CheckoutMaterializer, type VerificationOutcome } from "./mission-verification.js";
import { createFnAgent, promptWithFallback, type AgentResult } from "./pi.js";
import { mergeEffectiveSettings } from "./effective-settings.js";
import {
  createResolvedAgentSession,
  extractRuntimeHint,
  resolveValidatorSessionModel,
} from "./agent-session-helpers.js";
import { createLogger } from "./logger.js";
import { createFallbackModelObserver } from "./fallback-model-observer.js";
import { resolveMcpServersForStore } from "./mcp-resolution.js";
import { createRunAuditor, generateSyntheticRunId } from "./run-audit.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/** Shell-quote a single argument for a `git` invocation (mirror of the local
 * helper in branch-conflicts.ts — kept local rather than shared per repo
 * convention). */
function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Logger for the mission execution loop subsystem. */
export const loopLog = createLogger("mission-loop");

/** Maximum time (ms) to wait for a validation session to complete. */
const VALIDATION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Validation result returned by the AI agent.
 * The agent evaluates each linked assertion and returns pass/fail/blocked
 * per assertion plus an overall status.
 */
interface ValidationInspection {
  inspectionRoot: string;
  landedSha: string | undefined;
  fallbackUsed: boolean;
  workspaceStale: boolean;
  /** Why the inspected tree could not be proven to contain landed code. */
  inspectionUnavailableReason?: string;
}

interface ValidationWorkspaceStaleness {
  workspaceStale: boolean;
  inspectionUnavailableReason?: string;
}

interface ValidationExecution {
  result: ValidationResult;
  inspection: ValidationInspection;
}

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
    /** Per-assertion outcome; `passed` remains for legacy judge responses. */
    verdict: "pass" | "fail" | "blocked";
    passed: boolean;
    message?: string;
    expected?: string;
    actual?: string;
    evidence?: Array<{ kind?: string; text?: string }>;
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
  missionStore: MissionStore | AsyncMissionStore;
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
  /** Injectable disposable-checkout seam for validator inspection tests. */
  checkoutMaterializer?: CheckoutMaterializer;
}

export class MissionExecutionLoop extends EventEmitter {
  private running = false;
  private taskStore: TaskStore;
  private missionStore: MissionStore | AsyncMissionStore;
  private rootDir: string;
  private maxRetryBudget: number;
  private missionAutopilot?: MissionExecutionLoopOptions["missionAutopilot"];
  private pluginRunner?: MissionExecutionLoopOptions["pluginRunner"];
  private agentStore?: MissionExecutionLoopOptions["agentStore"];
  private verificationCapability?: MissionExecutionLoopOptions["verificationCapability"];
  private checkoutMaterializer: CheckoutMaterializer;
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
    this.checkoutMaterializer = options.checkoutMaterializer ?? new GitCheckoutMaterializer();
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
    const staleRuns = await this.missionStore.listStaleRunningValidatorRuns(maxAgeMs);
    let reapedCount = 0;

    for (const run of staleRuns) {
      if (this.activeValidations.has(run.featureId)) {
        continue;
      }

      try {
        const reapedRun = await this.missionStore.reapValidatorRun(
          run.id,
          `Validator run reaped after exceeding stale threshold (${maxAgeMs}ms) without a live owner.`,
        );
        reapedCount += 1;

        try {
          const milestone = await this.missionStore.getMilestone(reapedRun.milestoneId);
          const missionId = milestone ? (await this.missionStore.getMission(milestone.missionId))?.id : undefined;
          const elapsedMs = Math.max(0, Date.now() - new Date(run.startedAt).getTime());
          void this.taskStore.recordRunAuditEvent({
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
      const missions = await this.missionStore.listMissions();
      let recoveredCount = 0;

      for (const mission of missions) {
        if (mission.status !== "active") continue;

        let hierarchy;
        try {
          hierarchy = await this.missionStore.getMissionWithHierarchy(mission.id);
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

            const supersededFixes = await this.missionStore.reconcileSupersededGeneratedFixFeatures(slice.id);
            const supersededFeatureIds = new Set(supersededFixes.featureIds);
            if (supersededFixes.supersededCount > 0) {
              loopLog.warn(
                `Recovery: superseded ${supersededFixes.supersededCount} generated Fix Features in slice ${slice.id} `
                + "because an ancestor feature already passed validation",
              );
              recoveredCount += supersededFixes.supersededCount;
            }

            /*
            FNXC:PostgresMissionRecoveryPerformance 2026-07-14-17:55:
            Superseded-fix reconciliation can change multiple feature states. Refresh the slice once and reuse that coherent snapshot throughout recovery instead of issuing getFeature for every implementing or stranded feature.
            */
            const refreshedFeatures = await this.missionStore.listFeatures(slice.id);
            const refreshedById = new Map(refreshedFeatures.map((feature) => [feature.id, feature]));
            for (const feature of refreshedFeatures) {
              if (supersededFeatureIds.has(feature.id)) {
                continue;
              }

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
                const currentFeature = refreshedById.get(feature.id) ?? feature;
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
                const currentFeature = refreshedById.get(feature.id) ?? feature;
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

          /*
          FNXC:MissionValidation 2026-07-23-20:30:
          A parent-only contract has no feature-completion event to enter the
          rollup path. Recovery is also the milestone-completion trigger for
          zero-feature and no-feature-assertion milestones, but the shared
          readiness gate still requires all feature work to be done.
          */
          try {
            await this.runMilestoneValidationForMilestoneIfReady(milestone);
          } catch (err) {
            loopLog.error(`Recovery failed to validate milestone ${milestone.id}:`, err);
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
      const feature = await this.missionStore.getFeatureByTaskId(taskId);
      if (!feature) {
        loopLog.log(`Task ${taskId} has no linked feature; skipping validation`);
        return;
      }

      // Only validate features of active missions — mirrors the
      // recoverActiveMissions guard. A parked/blocked/completed mission must
      // not keep minting validations (and Fix features) for completed tasks.
      // Features that don't resolve to a mission keep the current behavior.
      const mission = await this.resolveFeatureMission(feature);
      if (mission && mission.status !== "active") {
        loopLog.log(`Feature ${feature.id} belongs to mission ${mission.id} with status "${mission.status}"; skipping validation`);
        await this.logFeatureWarningEvent(feature.id, "validation_skipped_mission_inactive", `Validation skipped: mission ${mission.id} status is "${mission.status}" (expected "active").`, {
          taskId,
          missionId: mission.id,
          missionStatus: mission.status,
        });
        return;
      }

      if (feature.loopState === "needs_fix") {
        await this.missionStore.transitionLoopState(feature.id, "implementing");
        feature.loopState = "implementing";
      }

      // Only validate features in "implementing" state
      if (feature.loopState !== "implementing") {
        loopLog.log(`Feature ${feature.id} loopState is "${feature.loopState}"; skipping validation`);
        await this.logFeatureWarningEvent(feature.id, "validation_skipped_loop_state", `Validation skipped: feature ${feature.id} is in loopState "${feature.loopState}" (expected "implementing").`, {
          taskId,
          loopState: feature.loopState,
        });
        return;
      }

      if (this.activeValidations.has(feature.id)) {
        loopLog.log(`Feature ${feature.id} already has an active validation; skipping duplicate trigger`);
        await this.logFeatureWarningEvent(feature.id, "validation_deduplicated", `Validation already running for feature ${feature.id}; duplicate trigger ignored.`, {
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
    /*
    FNXC:MissionValidation 2026-07-17-16:40:
    Claim validation before any asynchronous assertion lookup. Concurrent task
    completion events must share one validator run, including the lazy-link path.
    */
    this.activeValidations.add(feature.id);

    try {
      // Lazily guarantee a linked assertion before validation so every feature
      // is evaluated by the validator even when legacy data is missing links.
      let assertions = await this.missionStore.listAssertionsForFeature(feature.id);
      if (assertions.length === 0) {
        loopLog.log(`Feature ${feature.id} has no linked assertions; lazily ensuring store-managed assertion linkage`);
        assertions = await this.missionStore.ensureFeatureAssertionLinked(feature.id);
      }
      if (assertions.length === 0) {
        // FNXC:MissionValidation 2026-07-23-18:00: A feature without a derivable
        // contract can complete, but it must still trigger the direct milestone
        // path. That path independently proves all sibling work is done before
        // grading parent-only assertions; parent prose never becomes this feature's fail.
        await this.handleValidationPass(feature.id, undefined, "No assertions linked to feature");
        await this.runMilestoneValidationIfReady(feature);
        return;
      }

      loopLog.log(`Running internal validation for feature ${feature.id} — no board task created (policy: docs/missions.md)`);

      // FNXC:MissionValidation 2026-07-16-12:00:
      // Validator runs retain task linkage, while routing consumes inspection
      // provenance calculated in the exact root the judge read.
      const run = feature.taskId
        ? await this.missionStore.startValidatorRun(feature.id, "task_completion", feature.taskId)
        : await this.missionStore.startValidatorRun(feature.id, "task_completion");
      loopLog.log(`Started validator run ${run.id} for feature ${feature.id}`);

      const { result, inspection } = await this.runValidation(feature, assertions, run);

      // A fail is not durable evidence until its inspection root is trusted.
      // Do this before mutating assertion state: a pre-merge or stale checkout
      // must leave linked assertions pending for a later, trustworthy validator.
      const premergeColumn = result.status === "fail"
        ? await this.getPremergeTaskColumn(feature.taskId)
        : null;
      const deferredFail = result.status === "fail"
        && (Boolean(premergeColumn) || inspection.workspaceStale || Boolean(inspection.inspectionUnavailableReason));

      // Persist only authoritative results from a trusted inspection. The rollup
      // readiness gate consumes these statuses instead of model summary prose.
      const updateAssertion = (this.missionStore as unknown as {
        updateContractAssertion?: (id: string, updates: { status: "passed" | "blocked" | "failed" }) => unknown;
      }).updateContractAssertion;
      if (!deferredFail && typeof updateAssertion === "function") {
        for (const assertion of assertions) {
          const verdict = result.assertions.find((entry) => entry.assertionId === assertion.id);
          if (!verdict) continue;
          await updateAssertion.call(this.missionStore, assertion.id, {
            status: verdict.passed ? "passed" : verdict.verdict === "blocked" ? "blocked" : "failed",
          });
        }
      }

      // Handle the result
      if (result.status === "pass") {
        await this.handleValidationPass(feature.id, run.id, result.summary);
        await this.runMilestoneValidationIfReady(feature);
      } else if (result.status === "fail") {
        // A "fail" verdict is only trustworthy once the linked task's code has
        // actually landed (done/archived). If the task is still mid-pipeline
        // (in-review PR, external merge train, deferred base sync), the
        // validator judged a checkout that predates the merge — route to the
        // inconclusive outcome (R21, no Fix Feature) and let a later validation
        // judge the merged code. Missing task / unknown column falls through to
        // the normal fail handling (defer only on affirmative evidence).
        if (premergeColumn) {
          await this.handleValidationInconclusive(
            feature.id,
            run.id,
            `linked task ${feature.taskId} is still "${premergeColumn}" (code not merged yet) — validation deferred`,
          );
        } else if (inspection.workspaceStale || inspection.inspectionUnavailableReason) {
          // FNXC:MissionValidation 2026-07-16-14:00:
          // A FAIL can create a Fix Feature only after the judge's inspection
          // root is proven to contain the landed code. A stale root, unresolved
          // merge SHA, or unavailable ancestry result is inconclusive instead;
          // this prevents a wrong checkout from restarting implementation.
          const reason = inspection.workspaceStale
            ? `validation workspace predates the merged code for ${feature.taskId} — validation deferred`
            : `validation could not prove the inspected workspace contains merged code (${inspection.inspectionUnavailableReason}) — validation deferred`;
          await this.handleValidationInconclusive(feature.id, run.id, reason);
        } else {
          await this.handleValidationFail(feature.id, run.id, result);
        }
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
   * Resolve the linked task's column when it affirmatively shows the task has
   * NOT completed yet (any column other than "done"/"archived"). Returns null
   * when the task is completed, missing, unlinked, or unreadable — i.e. every
   * case where a fail verdict should be trusted. Fails open on purpose: the
   * guard may only ever defer a fail, never suppress one on missing data.
   */
  private async getPremergeTaskColumn(taskId: string | undefined): Promise<string | null> {
    if (!taskId) return null;
    const linkedTask = await this.taskStore.getTask(taskId).catch(() => null);
    const column = linkedTask?.column;
    if (!column || column === "done" || column === "archived") return null;
    return column;
  }

  /**
   * Determine whether the exact inspection root proves it contains landed code.
   * Exit 1 means the root is stale; missing SHA, bad objects, and other git
   * failures are unproven inspections and must defer a FAIL rather than mint a
   * remediation task from an unverifiable checkout.
   */
  private async isValidationWorkspaceStale(
    landedSha: string | undefined,
    inspectionRoot: string,
  ): Promise<ValidationWorkspaceStaleness> {
    if (!landedSha) {
      return { workspaceStale: false, inspectionUnavailableReason: "landed merge SHA is unavailable" };
    }
    try {
      await execAsync(`git merge-base --is-ancestor ${quoteShellArg(landedSha)} HEAD`, {
        cwd: inspectionRoot,
        timeout: 30_000,
      });
      return { workspaceStale: false }; // exit 0 → ancestor → workspace is fresh
    } catch (err) {
      // `--is-ancestor` exits 1 = NOT an ancestor (affirmatively stale). A bad
      // object/non-repo (usually 128) cannot prove the judge saw delivered code.
      if ((err as { code?: number })?.code === 1) return { workspaceStale: true };
      return { workspaceStale: false, inspectionUnavailableReason: "landed merge ancestry is unavailable" };
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
    scope: "feature" | "milestone" = "feature",
  ): Promise<ValidationExecution> {
    loopLog.log(`Running validation for feature ${feature.id} with ${assertions.length} assertions`);

    // FNXC:MissionValidation 2026-07-23-14:00:
    // FN-8542 confines an individual feature verdict to its linked feature
    // assertions. Parent milestone criteria are evaluated by the rollup lane,
    // so they are deliberately not supplied to this feature-validation session.
    const prompt = this.buildValidationPrompt(feature, assertions, scope);

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
    let checkout: Awaited<ReturnType<CheckoutMaterializer["materialize"]>> | undefined;
    const landedSha = await this.resolveIntegrationSha(feature);
    let inspectionRoot = this.rootDir;
    let fallbackUsed = !landedSha;

    // FNXC:MissionValidation 2026-07-16-12:00:
    // Issue #2168 requires the read-only judge to inspect the landed merge
    // checkout, not ambient rootDir whose branch can diverge. If checkout
    // materialization fails, retain rootDir behavior and evaluate staleness in
    // that exact fallback root before the disposable checkout is disposed.
    if (landedSha) {
      try {
        checkout = await this.checkoutMaterializer.materialize(this.rootDir, landedSha);
        inspectionRoot = checkout.dir;
        fallbackUsed = false;
      } catch (err) {
        loopLog.warn(`Unable to materialize validation checkout for ${feature.id}; using rootDir fallback:`, err);
      }
    }

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
        cwd: inspectionRoot,
        systemPrompt: this.buildValidationSystemPrompt(feature, assertions, taskContext, scope),
        tools: "readonly",
        defaultProvider: validationSessionModel.provider,
        defaultModelId: validationSessionModel.modelId,
        fallbackProvider: settings?.fallbackProvider,
        fallbackModelId: settings?.fallbackModelId,
        defaultThinkingLevel: "medium",
        runAuditor,
        settings,
        // FNXC:McpConfig 2026-06-25-23:19: Mission validation is a validator lane and receives the store-resolved MCP set at session creation; runtime gating and content-free skip logging remain centralized in pi.
        mcpServers: (await resolveMcpServersForStore(this.taskStore)).servers,
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

      const workspace = await this.isValidationWorkspaceStale(landedSha, inspectionRoot);
      loopLog.log(`Validation completed for feature ${feature.id}: ${result.status}`);
      return {
        result,
        inspection: { inspectionRoot, landedSha, fallbackUsed, ...workspace },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      loopLog.error(`Validation error for feature ${feature.id}:`, message);

      // Return an error result - the loop will handle it
      return {
        result: {
          status: "error",
          assertions: assertions.map((a) => ({
            assertionId: a.id,
            verdict: "fail",
            passed: false,
            message: `Validation error: ${message}`,
          })),
          summary: `Validation failed due to error: ${message}`,
        },
        inspection: { inspectionRoot, landedSha, fallbackUsed, workspaceStale: false },
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
      if (checkout) {
        try {
          await checkout.dispose();
        } catch (disposeErr) {
          loopLog.warn(`Error disposing validation checkout for ${feature.id}:`, disposeErr);
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

    // All parser outputs are canonicalized against the supplied linked assertion
    // set before this posture runs, including static-only runs. The absence of a
    // behavioral assertion merely avoids verification work; it must not restore
    // trust in a model-provided aggregate status.
    if (!hasBehavioral) {
      return this.deriveFeatureValidationStatus(judgeResult, false);
    }

    const textById = new Map(assertions.map((a) => [a.id, a.assertion]));
    let sawInconclusive = false;
    let inconclusiveReason: string | undefined;

    const newAssertionResults = await Promise.all(
      judgeResult.assertions.map(async (judged): Promise<ValidationResult["assertions"][number]> => {
        const type = typeById.get(judged.assertionId) ?? "static";
        if (type !== "behavioral") {
          // Static: keep judge verdict verbatim.
          return judged;
        }

        // Behavioral: default to fail unless verification confirms it.
        if (!this.verificationCapability) {
          return {
            ...judged,
            verdict: "fail",
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

        // A verifier must identify the same linked behavioral assertion it was
        // asked to exercise. Unmapped evidence is inconclusive diagnostics, not
        // permission to override another assertion or mint a feature fix.
        if (outcome.assertionId !== judged.assertionId || !typeById.has(outcome.assertionId)) {
          sawInconclusive = true;
          inconclusiveReason = inconclusiveReason ?? "behavioral verification returned an unmapped assertion";
          return {
            ...judged,
            verdict: "blocked",
            passed: false,
            message: "Behavioral verification returned unmapped evidence.",
          };
        }

        // FNXC:MissionValidationDiagnostics 2026-07-23-12:30: Behavioral verification is an authoritative execution path, so its reason/detail must join judge evidence before the shared normalizer bounds and redacts it.
        const behavioralEvidence = [{
          kind: "behavioral-verification",
          text: outcome.detail ? `${outcome.reason}\n${outcome.detail}` : outcome.reason,
        }];
        if (outcome.verdict === "pass") {
          return { ...judged, verdict: "pass", passed: true, message: outcome.reason, evidence: [...(judged.evidence ?? []), ...behavioralEvidence] };
        }
        if (outcome.verdict === "inconclusive") {
          sawInconclusive = true;
          inconclusiveReason = inconclusiveReason ?? outcome.reason;
          return {
            ...judged,
            verdict: "blocked",
            passed: false,
            message: `Behavioral verification inconclusive: ${outcome.reason}`,
            expected: judged.expected ?? "Behavior confirmed by a verification run",
            actual: outcome.detail ?? "Verification could not conclude",
            evidence: [...(judged.evidence ?? []), ...behavioralEvidence],
          };
        }
        // fail
        return {
          ...judged,
          verdict: "fail",
          passed: false,
          message: outcome.reason,
          expected: judged.expected ?? "Behavior confirmed by a verification run",
          actual: outcome.detail ?? judged.actual ?? "Behavior not confirmed",
          evidence: [...(judged.evidence ?? []), ...behavioralEvidence],
        };
      }),
    );

    const allPassed = newAssertionResults.every((a) => a.passed);

    // Inconclusive takes precedence over fail: an infra-driven non-pass must not
    // be mistaken for an observed behavioral failure (no Fix Feature).
    let status: ValidationResult["status"];
    if (sawInconclusive && !allPassed) {
      status = "inconclusive";
    } else {
      status = this.deriveFeatureValidationStatus({ ...judgeResult, assertions: newAssertionResults }, false).status;
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
   * Resolve the verified landed merge revision for a feature's linked task.
   *
   * FNXC:MissionValidation 2026-07-16-12:00:
   * `mergeDetails.commitSha` is the only delivered-code revision: it is the
   * landed merge tip. `baseCommitSha` is the task worktree fork point and must
   * never be inspected as delivered code; Task has no `integrationSha` or
   * `baseCommit` fields. Inspection-root pinning, stale checking, and
   * behavioral verification all consume this same revision.
   */
  private async resolveIntegrationSha(feature: MissionFeature): Promise<string | undefined> {
    if (!feature.taskId) return undefined;
    try {
      const task = await this.taskStore.getTask(feature.taskId);
      return task?.mergeDetails?.commitSha;
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

      return this.deriveFeatureValidationStatus({
        status,
        assertions: assertionResults,
        summary,
        blockedReason,
      }, true);
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
  ): ValidationResult["assertions"] {
    const byId = new Map<string, ValidationResult["assertions"][number]>();
    const authoritativeIds = new Set(assertions.map((assertion) => assertion.id));
    const duplicateIds = new Set<string>();

    // FNXC:MissionValidation 2026-07-23-14:00:
    // FN-8542 makes a contradictory aggregate structurally impossible. Only one
    // result for every authoritative linked assertion participates; unknown IDs
    // are ignored, duplicates and omissions are non-passing evidence.
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

          // FNXC:MissionValidationDiagnostics 2026-07-23-13:15: A validation
          // run may fail while an individual assertion is blocked. Preserve that
          // identity instead of collapsing every non-pass into a failed assertion.
          const verdict = assertionItem.verdict === "pass" || assertionItem.verdict === "fail" || assertionItem.verdict === "blocked"
            ? assertionItem.verdict
            : assertionItem.passed === true ? "pass" : "fail";
          const passed = verdict === "pass";

          const evidence = Array.isArray(assertionItem.evidence)
            ? assertionItem.evidence.flatMap((entry) => {
              if (typeof entry !== "object" || entry === null) return [];
              const candidate = entry as Record<string, unknown>;
              const kind = typeof candidate.kind === "string" ? candidate.kind : undefined;
              const text = typeof candidate.text === "string" ? candidate.text : undefined;
              return kind || text ? [{ ...(kind ? { kind } : {}), ...(text ? { text } : {}) }] : [];
            })
            : undefined;
          if (!assertionId || !authoritativeIds.has(assertionId)) continue;
          if (byId.has(assertionId)) {
            duplicateIds.add(assertionId);
            continue;
          }
          byId.set(assertionId, {
            assertionId,
            verdict,
            passed,
            message: typeof assertionItem.message === "string" ? assertionItem.message : undefined,
            expected: typeof assertionItem.expected === "string" ? assertionItem.expected : undefined,
            actual: typeof assertionItem.actual === "string" ? assertionItem.actual : undefined,
            ...(evidence ? { evidence } : {}),
          });
        }
      }
    }

    return assertions.map((assertion) => {
      if (duplicateIds.has(assertion.id)) {
        return {
          assertionId: assertion.id,
          verdict: "fail" as const,
          passed: false,
          message: "Duplicate validator result for linked assertion.",
        };
      }
      return byId.get(assertion.id) ?? {
        assertionId: assertion.id,
        verdict: "fail" as const,
        passed: false,
        message: "Validator omitted linked assertion result.",
      };
    });
  }

  /**
   * Derive an aggregate only from canonical linked assertion results.
   * Model summary prose and its aggregate status are intentionally excluded.
   */
  private deriveFeatureValidationStatus(
    result: ValidationResult,
    preserveTerminal: boolean,
  ): ValidationResult {
    if (preserveTerminal && (result.status === "error" || result.status === "blocked")) return result;
    if (result.assertions.some((assertion) => assertion.verdict === "blocked")) {
      return { ...result, status: "blocked" };
    }
    return {
      ...result,
      status: result.assertions.length > 0 && result.assertions.every((assertion) => assertion.passed)
        ? "pass"
        : "fail",
    };
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
        verdict: "fail",
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
    scope: "feature" | "milestone" = "feature",
  ): string {
    const assertionTexts = assertions
      .map((a, i) => `${i + 1}. **${a.title}**: ${a.assertion}`)
      .join("\n");

    const subject = scope === "milestone" ? "milestone rollup" : `feature "${feature.title}"`;
    const boundary = scope === "milestone" ? "milestone-scoped" : "linked feature";
    return `Evaluate the implementation for ${subject} against only the following ${boundary} contract assertions:

${assertionTexts}
For each assertion:
- Determine if the implementation satisfies the assertion (pass/fail/blocked)
- If failed, explain what was expected vs what was actually observed
- If blocked, explain what external factor prevented validation

Respond with a JSON object in this format:
{
  "status": "pass|fail|blocked",
  "assertions": [
    {
      "assertionId": "CA-...",
      "verdict": "pass|fail|blocked",
      "passed": true|false,
      "message": "Explanation for this verdict",
      "expected": "What was expected",
      "actual": "What was observed",
      "evidence": [{ "kind": "file|command|test-output|other", "text": "Concise file, command, or test-output reference used for this verdict" }]
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
    scope: "feature" | "milestone" = "feature",
  ): string {
    const boundary = scope === "milestone" ? "milestone-scoped" : "linked feature";
    return `You are a validation agent responsible for evaluating whether an implementation satisfies its ${boundary} contract assertions.

You will receive:
1. A feature description with its acceptance criteria
2. ${boundary} contract assertions to evaluate against
3. Task context including the implementation details

Your job is to:
1. Carefully review the implementation as described in the task context
2. Evaluate each supplied ${boundary} contract assertion objectively
3. Determine if the implementation fully satisfies each supplied assertion
4. Return a structured JSON response with your findings

Be thorough and precise. A contract assertion represents a commitment made during planning - the implementation must fully satisfy it or it is considered failed.

Evaluation guidance:
- "pass" means all required assertions are fully satisfied.
- "fail" means one or more assertions are unmet or only partially satisfied.
- "blocked" means you cannot evaluate due to missing/insufficient evidence or external constraints.
- Partial satisfaction must be marked as failed with clear expected vs actual details.
- For every assertion, include the concrete evidence you considered. Evidence must identify the relevant file, command, or concise test output; do not include secrets or full unbounded command output.

Response format: Return ONLY a JSON object (no additional text) with this structure:
{
  "status": "pass|fail|blocked",
  "assertions": [
    {
      "assertionId": "The assertion ID",
      "passed": true|false,
      "message": "Explanation of your evaluation",
      "expected": "What the assertion required",
      "actual": "What you observed in the implementation",
      "evidence": [{ "kind": "file|command|test-output|other", "text": "Concise file, command, or test-output reference used for this verdict" }]
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

  /*
  FNXC:MissionValidation 2026-07-23-15:20:
  Parent acceptance criteria are judged only after every feature assertion is
  linked and terminal-passed. This separate rollup pass can update only
  milestone assertions; it never routes parent failures through feature fixes.
  */
  private async runMilestoneValidationIfReady(feature: MissionFeature): Promise<void> {
    const milestone = await this.resolveFeatureMilestone(feature);
    if (!milestone) return;
    await this.runMilestoneValidationForMilestoneIfReady(milestone, feature);
  }

  private async runMilestoneValidationForMilestoneIfReady(
    milestone: Milestone,
    contextFeature?: MissionFeature,
  ): Promise<void> {
    if (typeof this.missionStore.listContractAssertions !== "function"
      || typeof this.missionStore.listFeaturesForAssertion !== "function"
      || typeof this.missionStore.updateContractAssertion !== "function") return;
    /*
    FNXC:MissionValidation 2026-07-23-17:20:
    A parent pass must wait for coverage of every acceptance-bearing sibling,
    not merely the feature assertions that happened to exist when this feature
    finished. Lazy-link those siblings before checking terminal feature scope.
    */
    const slices = await this.missionStore.listSlices(milestone.id);
    const features = (await Promise.all(slices.map((slice) => this.missionStore.listFeatures(slice.id)))).flat();
    for (const sibling of features) {
      if ((sibling.acceptanceCriteria ?? "").trim()) {
        const linked = await this.missionStore.ensureFeatureAssertionLinked(sibling.id);
        if (linked.length === 0) return;
      }
    }

    const assertions = await this.missionStore.listContractAssertions(milestone.id);
    const featureAssertions = assertions.filter((assertion) => assertion.scope !== "milestone");
    const milestoneAssertions = assertions.filter((assertion) => assertion.scope === "milestone");
    if (milestoneAssertions.length === 0) return;

    /*
    FNXC:MissionValidation 2026-07-23-18:00:
    Derived or authored parent assertions may be the only contract in a
    milestone. Permit their direct rollup only after every feature's work is
    done; otherwise an early no-assertion feature could grade parent scope.
    */
    if (featureAssertions.length === 0) {
      if (!features.every((sibling) => sibling.status === "done")) return;
    }

    for (const assertion of featureAssertions) {
      const linked = await this.missionStore.listFeaturesForAssertion(assertion.id);
      if (linked.length === 0 || assertion.status !== "passed") return;
    }

    const validationFeature = contextFeature ?? features[0];
    const rollupContext = validationFeature ?? {
      id: `milestone:${milestone.id}`,
      sliceId: slices[0]?.id ?? "",
      title: milestone.title,
      status: "done" as const,
      loopState: "passed" as const,
      implementationAttemptCount: 0,
      validatorAttemptCount: 0,
      createdAt: milestone.createdAt,
      updatedAt: milestone.updatedAt,
    };
    const { result } = await this.runValidation(rollupContext, milestoneAssertions, {} as MissionValidatorRun, "milestone");
    for (const assertion of milestoneAssertions) {
      const verdict = result.assertions.find((entry) => entry.assertionId === assertion.id);
      // Unknown, duplicate, omitted, or non-passing evidence remains non-passing.
      const status = verdict?.passed ? "passed" : result.status === "blocked" ? "blocked" : "failed";
      await this.missionStore.updateContractAssertion(assertion.id, { status });
    }
  }

  private async resolveFeatureMilestone(feature: MissionFeature): Promise<Milestone | undefined> {
    const slice = await this.missionStore.getSlice(feature.sliceId);
    if (!slice) {
      return undefined;
    }

    return this.missionStore.getMilestone(slice.milestoneId);
  }

  private async resolveFeatureMission(feature: MissionFeature): Promise<Mission | undefined> {
    const milestone = await this.resolveFeatureMilestone(feature);
    if (!milestone) {
      return undefined;
    }

    return this.missionStore.getMission(milestone.missionId);
  }

  private async completeValidatorRunIfStillRunning(
    runId: string | undefined,
    status: "passed" | "failed" | "blocked" | "error",
    summaryOrReason?: string,
  ): Promise<boolean> {
    if (!runId) {
      return false;
    }

    if (typeof this.missionStore.getValidatorRun !== "function") {
      await this.missionStore.completeValidatorRun(runId, status, summaryOrReason);
      return true;
    }

    const run = await this.missionStore.getValidatorRun(runId);
    if (!run || run.status !== "running") {
      loopLog.warn(`Validator run ${runId} is no longer running; skipping ${status} completion.`);
      return false;
    }

    await this.missionStore.completeValidatorRun(runId, status, summaryOrReason);
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
      await this.completeValidatorRunIfStillRunning(runId, "passed", summary);

      const feature = await this.missionStore.getFeature(featureId);
      if (feature && feature.status !== "done") {
        await this.missionStore.updateFeatureStatus(featureId, "done");
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

      const canCompleteRun = runId ? (await this.missionStore.getValidatorRun(runId))?.status === "running" : false;

      if (runId && failures.length > 0 && canCompleteRun) {
        await this.missionStore.recordValidatorFailures(runId, failures);
      }

      await this.completeValidatorRunIfStillRunning(runId, "failed", result.summary);

      loopLog.log(`Feature ${featureId} failed validation with ${failures.length} failures`);

      // FNXC:MissionValidationDiagnostics 2026-07-23-12:00: The normalized verdict—not an LLM summary—drives every persisted failure surface.
      const diagnostics: ValidationDiagnostics = normalizeValidationDiagnostics({
        runId: runId ?? "unknown",
        sourceFeatureId: featureId,
        outcome: "fail",
        projectRoot: this.rootDir,
        assertions: result.assertions.map((assertion) => ({
          assertionId: assertion.assertionId,
          verdict: assertion.verdict,
          passed: assertion.passed,
          message: assertion.message,
          expected: assertion.expected,
          actual: assertion.actual,
          evidence: assertion.evidence,
        })),
      });
      const failureReason = this.buildFailureReason(failures, "");
      await this.logFeatureMissionEvent(featureId, "error", "validation_failed", renderValidationFailureDescription(diagnostics), {
        validationDiagnostics: diagnostics,
        runId: diagnostics.runId,
        failedAssertionIds: failures.map((f) => f.assertionId),
        outcome: "fail",
      });

      // Create fix feature
      try {
        const fixFeature = await this.missionStore.createGeneratedFixFeature(
          featureId,
          runId || "unknown",
          failures.map((f) => f.assertionId),
          failureReason,
          undefined,
          diagnostics,
        );
        loopLog.log(`Created fix feature ${fixFeature.id} for ${featureId}`);

        // Auto-triage only a newly untriaged fix. createGeneratedFixFeature is
        // deliberately idempotent and can return an existing in-progress fix;
        // its durable task link is the canonical proof that triage already won.
        // FNXC:MissionValidationDiagnostics 2026-07-23-12:35: Duplicate validator triggers must silently reuse a fix feature with a linked board task instead of surfacing a false triage failure.
        const linkedFixTask = fixFeature.taskId ? await this.taskStore.getTask(fixFeature.taskId).catch(() => undefined) : undefined;
        // FNXC:MissionValidationDiagnostics 2026-07-23-13:15: A stale task ID
        // is not proof that remediation is live. Only an open, non-deleted task
        // makes duplicate triage safe to suppress; otherwise persist an action.
        const hasLiveFixTask = Boolean(linkedFixTask && !linkedFixTask.deletedAt && linkedFixTask.column !== "done" && linkedFixTask.column !== "archived" && linkedFixTask.status !== "failed");
        if (hasLiveFixTask) {
          loopLog.log(`Fix feature ${fixFeature.id} already has canonical task ${fixFeature.taskId}; skipping duplicate triage`);
        } else try {
          await this.missionStore.triageFeature(fixFeature.id);
          loopLog.log(`Auto-triaged fix feature ${fixFeature.id}`);
        } catch (triageErr) {
          const triageMessage = triageErr instanceof Error ? triageErr.message : String(triageErr);
          loopLog.error(`Error triaging fix feature ${fixFeature.id}:`, triageMessage);
          // R16 — a swallowed triage error must be durably recorded, not just
          // logged. The branch-group-collision learning: silent triage stalls
          // are invisible mission deadlocks. The Fix Feature was created and can
          // be triaged manually, so we continue, but the failure is persisted.
          await this.logFeatureMissionEvent(featureId, "warning", "fix_feature_triage_needs_attention", `Fix feature ${fixFeature.id} was created but needs operator triage. Inspect the feature and retry triage.`, {
            runId: runId ?? null,
            fixFeatureId: fixFeature.id,
            state: "needs-triage",
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
          await this.logFeatureMissionEvent(featureId, "error", "retry_budget_exhausted", `Feature ${featureId} exhausted its retry budget`, {
            runId: runId ?? null,
          });
          this.emit("validation:budget_exhausted", { featureId, runId });
        } else {
          loopLog.error(`Error creating fix feature for ${featureId}:`, message);
          // R16 — a swallowed Fix-Feature creation error is durably recorded.
          await this.logFeatureMissionEvent(featureId, "error", "fix_feature_creation_needs_attention", `Validation remediation could not be created for feature ${featureId}. Inspect the validator run and retry validation or triage.`, {
            runId: runId ?? null,
            state: "remediation-creation-failed",
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
      await this.completeValidatorRunIfStillRunning(runId, "blocked", reason);
      loopLog.warn(`Feature ${featureId} verification inconclusive: ${reason ?? "no reason provided"}`);

      // R16/R21 — durable, distinguishable infra-failure event. The `outcome`
      // marker separates infra-driven non-passes from real behavioral fails so
      // the infra-failure rate can be tracked without conflating the two.
      await this.logFeatureMissionEvent(featureId, "warning", "verification_inconclusive", `Verification inconclusive for feature ${featureId}: ${reason ?? "verification could not conclude"}`, {
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
      await this.completeValidatorRunIfStillRunning(runId, "blocked", blockedReason);
      loopLog.log(`Feature ${featureId} blocked: ${blockedReason}`);
      await this.logFeatureErrorEvent(featureId, "validation_blocked", `Validation blocked for feature ${featureId}: ${blockedReason ?? "no reason provided"}`, {
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
      await this.completeValidatorRunIfStillRunning(runId, "error", error);
      loopLog.error(`Feature ${featureId} validation error: ${error}`);
      await this.logFeatureErrorEvent(featureId, "validation_error", `Validation error for feature ${featureId}: ${error}`, {
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

  private async logFeatureWarningEvent(
    featureId: string,
    code: string,
    description: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.logFeatureMissionEvent(featureId, "warning", code, description, metadata);
  }

  private async logFeatureErrorEvent(
    featureId: string,
    code: string,
    description: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.logFeatureMissionEvent(featureId, "error", code, description, metadata);
  }

  private async logFeatureMissionEvent(
    featureId: string,
    eventType: "warning" | "error",
    code: string,
    description: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      const feature = await this.missionStore.getFeature(featureId);
      if (!feature) return;
      const slice = await this.missionStore.getSlice(feature.sliceId);
      if (!slice) return;
      const milestone = await this.missionStore.getMilestone(slice.milestoneId);
      if (!milestone) return;
      await this.missionStore.logMissionEvent?.(milestone.missionId, eventType, description, {
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
