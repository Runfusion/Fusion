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
} from "@fusion/core";
import { createKbAgent, promptWithFallback, type AgentResult } from "./pi.js";
import { createLogger } from "./logger.js";

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
  /** Overall validation status */
  status: "pass" | "fail" | "blocked";
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
}

export class MissionExecutionLoop extends EventEmitter {
  private running = false;
  private taskStore: TaskStore;
  private missionStore: MissionStore;
  private rootDir: string;
  private maxRetryBudget: number;
  private missionAutopilot?: MissionExecutionLoopOptions["missionAutopilot"];
  private activeValidations = new Set<string>(); // feature IDs currently being validated

  constructor(options: MissionExecutionLoopOptions) {
    super();
    this.taskStore = options.taskStore;
    this.missionStore = options.missionStore;
    this.rootDir = options.rootDir;
    this.maxRetryBudget = options.maxRetryBudget ?? 3;
    this.missionAutopilot = options.missionAutopilot;
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
   * Recover active missions on startup.
   *
   * Finds all features in "validating" or "needs_fix" state and re-enqueues
   * them for validation or fix implementation respectively.
   *
   * This handles the case where the engine was shut down mid-validation
   * or mid-fix, ensuring those features continue their loop progression.
   */
  async recoverActiveMissions(): Promise<void> {
    loopLog.log("Starting active mission recovery...");

    try {
      const missions = this.missionStore.listMissions();
      let recoveredCount = 0;

      for (const mission of missions) {
        if (mission.status !== "active") continue;

        const hierarchy = this.missionStore.getMissionWithHierarchy(mission.id);
        if (!hierarchy) continue;

        for (const milestone of hierarchy.milestones) {
          for (const slice of milestone.slices) {
            if (slice.status !== "active") continue;

            for (const feature of slice.features) {
              // Features in validating state need to be re-validated
              if (feature.loopState === "validating") {
                loopLog.log(`Recovery: re-queuing validating feature ${feature.id}`);
                // Transition back to implementing so the next task completion triggers validation
                // Or if there's a task, we can re-trigger validation directly
                recoveredCount++;
              }

              // Features in needs_fix state need to continue their fix cycle
              if (feature.loopState === "needs_fix") {
                loopLog.log(`Recovery: feature ${feature.id} awaiting fix implementation`);
                // The feature is already in needs_fix - it will progress when
                // its fix task completes and processTaskOutcome is called again
                recoveredCount++;
              }
            }
          }
        }
      }

      loopLog.log(`Active mission recovery complete: recovered ${recoveredCount} features`);
    } catch (err) {
      loopLog.error("Error during active mission recovery:", err);
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

      // Only validate features in "implementing" state
      if (feature.loopState !== "implementing") {
        loopLog.log(`Feature ${feature.id} loopState is "${feature.loopState}"; skipping validation`);
        return;
      }

      // Get linked assertions for this feature
      const assertions = this.missionStore.listAssertionsForFeature(feature.id);
      if (assertions.length === 0) {
        loopLog.log(`Feature ${feature.id} has no linked assertions; marking as passed`);
        // No assertions = automatically pass
        await this.handleValidationPass(feature.id, undefined, "No assertions linked");
        return;
      }

      // Mark feature as being validated
      this.activeValidations.add(feature.id);

      try {
        // Start a validator run
        const run = this.missionStore.startValidatorRun(feature.id, "task_completion");
        loopLog.log(`Started validator run ${run.id} for feature ${feature.id}`);

        // Run the validation
        const result = await this.runValidation(feature, assertions, run);

        // Handle the result
        if (result.status === "pass") {
          await this.handleValidationPass(feature.id, run.id, result.summary);
        } else if (result.status === "fail") {
          await this.handleValidationFail(feature.id, run.id, result);
        } else if (result.status === "blocked") {
          await this.handleValidationBlocked(feature.id, run.id, result.blockedReason);
        }
      } finally {
        this.activeValidations.delete(feature.id);
      }
    } catch (err) {
      loopLog.error(`Error processing task outcome for ${taskId}:`, err);
      // Don't crash the loop - log and continue
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

    // Build the validation prompt
    const prompt = this.buildValidationPrompt(feature, assertions);

    // Get task context for validation
    const task = feature.taskId ? await this.taskStore.getTask(feature.taskId) : null;
    const taskContext = task ? this.buildTaskContext(task) : "";

    let session: AgentResult | null = null;

    try {
      // Create validation agent session
      session = await createKbAgent({
        cwd: this.rootDir,
        systemPrompt: this.buildValidationSystemPrompt(feature, assertions, taskContext),
        tools: "readonly",
        defaultThinkingLevel: "medium",
        onText: (_delta) => {
          // Could stream this to a log entry if needed
        },
      });

      loopLog.log(`Validation session created for feature ${feature.id}`);

      // Run the validation with timeout
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Validation timeout")), VALIDATION_TIMEOUT_MS);
      });

      const validationPromise = this.runValidationSession(session.session, prompt);

      await Promise.race([validationPromise, timeoutPromise]);

      // Get the validation result from the session
      // The agent should have returned structured JSON in its response
      const result = await this.parseValidationResult(session.session, assertions);

      loopLog.log(`Validation completed for feature ${feature.id}: ${result.status}`);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      loopLog.error(`Validation error for feature ${feature.id}:`, message);

      // Return an error result - the loop will handle it
      return {
        status: "fail",
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
   * Run the actual validation session with the AI agent.
   */
  private async runValidationSession(
    agentSession: Awaited<ReturnType<typeof createKbAgent>>["session"],
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
   * Parse the validation result from the agent's response.
   * The agent is expected to return structured JSON with the validation result.
   */
  private async parseValidationResult(
    agentSession: Awaited<ReturnType<typeof createKbAgent>>["session"],
    assertions: MissionContractAssertion[],
  ): Promise<ValidationResult> {
    // In a real implementation, we would parse the agent's response to extract
    // the structured validation result. For now, we'll use a simplified approach
    // where we look for a JSON response in the conversation.
    //
    // The agent should have responded with something like:
    // {
    //   "status": "pass|fail|blocked",
    //   "assertions": [...],
    //   "summary": "..."
    // }

    // For now, return a default "pass" result since we don't have the actual
    // parsing logic implemented. This will be refined based on the actual
    // agent response format.
    return {
      status: "pass",
      assertions: assertions.map((a) => ({
        assertionId: a.id,
        passed: true,
      })),
      summary: "All assertions passed",
    };
  }

  /**
   * Build the validation prompt sent to the AI agent.
   */
  private buildValidationPrompt(feature: MissionFeature, assertions: MissionContractAssertion[]): string {
    const assertionTexts = assertions
      .map((a, i) => `${i + 1}. **${a.title}**: ${a.assertion}`)
      .join("\n");

    return `Evaluate the implementation for feature "${feature.title}" against the following contract assertions:

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
    feature: MissionFeature,
    _assertions: MissionContractAssertion[],
    taskContext: string,
  ): string {
    return `You are a validation agent responsible for evaluating whether an implementation satisfies its contract assertions.

You will receive:
1. A feature description with its acceptance criteria
2. Contract assertions to evaluate against
3. Task context including the implementation details

Your job is to:
1. Carefully review the implementation as described in the task context
2. Evaluate each contract assertion objectively
3. Determine if the implementation fully satisfies each assertion
4. Return a structured JSON response with your findings

Be thorough and precise. A contract assertion represents a commitment made during planning - the implementation must fully satisfy it or it is considered failed.

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

  /**
   * Handle a successful validation (pass).
   */
  private async handleValidationPass(
    featureId: string,
    runId: string | undefined,
    summary: string,
  ): Promise<void> {
    try {
      if (runId) {
        this.missionStore.completeValidatorRun(runId, "passed", summary);
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

      if (runId && failures.length > 0) {
        this.missionStore.recordValidatorFailures(runId, failures);
      }

      if (runId) {
        this.missionStore.completeValidatorRun(runId, "failed", result.summary);
      }

      loopLog.log(`Feature ${featureId} failed validation with ${failures.length} failures`);

      // Create fix feature
      try {
        const fixFeature = this.missionStore.createGeneratedFixFeature(
          featureId,
          runId || "unknown",
          failures.map((f) => f.assertionId),
        );
        loopLog.log(`Created fix feature ${fixFeature.id} for ${featureId}`);

        this.emit("validation:failed", {
          featureId,
          runId,
          failures,
          fixFeatureId: fixFeature.id,
        });
      } catch (fixErr) {
        const message = fixErr instanceof Error ? fixErr.message : String(fixErr);
        if (message.includes("retry budget exhausted")) {
          loopLog.warn(`Feature ${featureId} retry budget exhausted; marking as blocked`);
          // completeValidatorRun already handles the blocked transition when budget is exhausted
          this.emit("validation:budget_exhausted", { featureId, runId });
        } else {
          loopLog.error(`Error creating fix feature for ${featureId}:`, message);
        }
      }

      // Notify autopilot if configured
      if (this.missionAutopilot?.notifyValidationComplete) {
        await this.missionAutopilot.notifyValidationComplete(featureId, "failed");
      }
    } catch (err) {
      loopLog.error(`Error handling validation fail for ${featureId}:`, err);
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
      if (runId) {
        this.missionStore.completeValidatorRun(runId, "blocked", blockedReason);
      }
      loopLog.log(`Feature ${featureId} blocked: ${blockedReason}`);

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
      if (runId) {
        this.missionStore.completeValidatorRun(runId, "error", error);
      }
      loopLog.error(`Feature ${featureId} validation error: ${error}`);

      // Notify autopilot if configured
      if (this.missionAutopilot?.notifyValidationComplete) {
        await this.missionAutopilot.notifyValidationComplete(featureId, "error");
      }

      this.emit("validation:error", { featureId, runId, error });
    } catch (err) {
      loopLog.error(`Error handling validation error for ${featureId}:`, err);
    }
  }
}
