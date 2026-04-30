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
} from "@fusion/core";
import { createFnAgent, promptWithFallback, type AgentResult } from "./pi.js";
import { createResolvedAgentSession, extractRuntimeHint } from "./agent-session-helpers.js";
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
  status: "pass" | "fail" | "blocked" | "error";
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
  async recoverActiveMissions(): Promise<{ recoveredCount: number }> {
    loopLog.log("Starting active mission recovery...");

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
                    await this.processTaskOutcome(feature.taskId);
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
                    await this.processTaskOutcome(feature.taskId);
                    recoveredCount++;
                  } catch (err) {
                    loopLog.error(`Recovery failed for needs_fix feature ${feature.id}:`, err);
                  }
                } else {
                  recoveredCount++;
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

    // Track the validation board task ID (created later if there are assertions)
    let validationTaskId: string | undefined;

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
        await this.handleValidationPass(feature.id, undefined, "No assertions linked", undefined);
        return;
      }

      // Mark feature as being validated
      this.activeValidations.add(feature.id);

      try {
        // Resolve mission context for creating the validation board task
        const featureSlice = this.missionStore.getSlice(feature.sliceId);
        const featureMilestone = featureSlice ? this.missionStore.getMilestone(featureSlice.milestoneId) : undefined;
        const missionId = featureMilestone?.missionId;

        // Create a visible board task for this validation run
        const validationTask = await this.taskStore.createTask({
          title: `🔍 Validate: ${feature.title}`,
          description: `Validating implementation for feature "${feature.title}" against ${assertions.length} contract assertion(s).\n\nFeature: ${feature.id}\nSlice: ${feature.sliceId}\nAssertions: ${assertions.map(a => a.title).join(", ")}`,
          column: "in-progress",
          missionId,
          sliceId: feature.sliceId,
          source: {
            sourceType: "automation",
            sourceMetadata: {
              missionId,
              featureId: feature.id,
              sliceId: feature.sliceId,
            },
          },
        });
        validationTaskId = validationTask.id;

        // Mark as validation task so scheduler/stuck-detector skip it
        await this.taskStore.updateTask(validationTaskId, { status: "mission-validation" });
        loopLog.log(`Created validation board task ${validationTaskId} for feature ${feature.id}`);

        // Start the validator run, linked to the board task
        const run = this.missionStore.startValidatorRun(feature.id, "task_completion", validationTaskId);
        loopLog.log(`Started validator run ${run.id} for feature ${feature.id}`);

        // Run the validation
        const result = await this.runValidation(feature, assertions, run);

        // Handle the result
        if (result.status === "pass") {
          await this.handleValidationPass(feature.id, run.id, result.summary, validationTaskId);
        } else if (result.status === "fail") {
          await this.handleValidationFail(feature.id, run.id, result, validationTaskId);
        } else if (result.status === "blocked") {
          await this.handleValidationBlocked(feature.id, run.id, result.blockedReason, validationTaskId);
        } else if (result.status === "error") {
          await this.handleValidationError(feature.id, run.id, result.summary, validationTaskId);
        }
      } finally {
        this.activeValidations.delete(feature.id);
      }
    } catch (err) {
      loopLog.error(`Error processing task outcome for ${taskId}:`, err);
      // Move the validation task to in-review if it exists
      if (validationTaskId) {
        try {
          await this.taskStore.updateTask(validationTaskId, {
            error: err instanceof Error ? err.message : String(err),
            summary: "Validation failed unexpectedly",
          });
          await this.taskStore.moveTask(validationTaskId, "in-review");
        } catch (moveErr) {
          loopLog.error(`Failed to move validation task ${validationTaskId} on error:`, moveErr);
        }
      }
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
    const validationRuntimeHint = task?.assignedAgentId && this.agentStore
      ? extractRuntimeHint((await this.agentStore.getAgent(task.assignedAgentId).catch(() => null))?.runtimeConfig)
      : undefined;

    let session: AgentResult | null = null;

    try {
      // Create validation agent session
      const sessionResult = await createResolvedAgentSession({
        sessionPurpose: "validation",
        runtimeHint: validationRuntimeHint,
        pluginRunner: this.pluginRunner,
        cwd: this.rootDir,
        systemPrompt: this.buildValidationSystemPrompt(feature, assertions, taskContext),
        tools: "readonly",
        defaultThinkingLevel: "medium",
        onText: (_delta) => {
          // Could stream this to a log entry if needed
        },
      });
      session = { session: sessionResult.session, sessionFile: sessionResult.sessionFile };

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

    // If no assertion results but we have assertions, create default results based on status
    if (results.length === 0 && assertions.length > 0) {
      const overallPassed = parsed.status === "pass";
      for (const assertion of assertions) {
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

Evaluation guidance:
- "pass" means all required assertions are fully satisfied.
- "fail" means one or more assertions are unmet or only partially satisfied.
- "blocked" means you cannot evaluate due to missing/insufficient evidence or external constraints.
- Partial satisfaction must be marked as failed with clear expected vs actual details.

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
    validationTaskId: string | undefined,
  ): Promise<void> {
    try {
      if (runId) {
        this.missionStore.completeValidatorRun(runId, "passed", summary);
      }
      loopLog.log(`Feature ${featureId} passed validation`);

      // Move the validation board task to done if it exists
      if (validationTaskId) {
        await this.taskStore.updateTask(validationTaskId, {
          summary: summary || "Validation passed",
        });
        await this.taskStore.moveTask(validationTaskId, "done");
        loopLog.log(`Moved validation task ${validationTaskId} to done`);
      }

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
    validationTaskId: string | undefined,
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

      // Move the validation board task to in-review if it exists
      if (validationTaskId) {
        await this.taskStore.updateTask(validationTaskId, {
          error: result.summary,
          summary: `Failed: ${failures.length} assertion(s) failed`,
        });
        await this.taskStore.moveTask(validationTaskId, "in-review");
        loopLog.log(`Moved validation task ${validationTaskId} to in-review`);
      }

      // Create fix feature
      try {
        const fixFeature = this.missionStore.createGeneratedFixFeature(
          featureId,
          runId || "unknown",
          failures.map((f) => f.assertionId),
        );
        loopLog.log(`Created fix feature ${fixFeature.id} for ${featureId}`);

        // Auto-triage the fix feature so the retry loop can continue
        try {
          await this.missionStore.triageFeature(fixFeature.id);
          loopLog.log(`Auto-triaged fix feature ${fixFeature.id}`);
        } catch (triageErr) {
          const triageMessage = triageErr instanceof Error ? triageErr.message : String(triageErr);
          loopLog.error(`Error triaging fix feature ${fixFeature.id}:`, triageMessage);
          // Continue even if triage fails - the fix feature was created and can be triaged manually
        }

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
    validationTaskId: string | undefined,
  ): Promise<void> {
    try {
      if (runId) {
        this.missionStore.completeValidatorRun(runId, "blocked", blockedReason);
      }
      loopLog.log(`Feature ${featureId} blocked: ${blockedReason}`);

      // Move the validation board task to in-review if it exists
      if (validationTaskId) {
        await this.taskStore.updateTask(validationTaskId, {
          error: blockedReason,
          summary: `Blocked: ${blockedReason}`,
        });
        await this.taskStore.moveTask(validationTaskId, "in-review");
        loopLog.log(`Moved validation task ${validationTaskId} to in-review`);
      }

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
    validationTaskId: string | undefined,
  ): Promise<void> {
    try {
      if (runId) {
        this.missionStore.completeValidatorRun(runId, "error", error);
      }
      loopLog.error(`Feature ${featureId} validation error: ${error}`);

      // Move the validation board task to in-review if it exists
      if (validationTaskId) {
        await this.taskStore.updateTask(validationTaskId, {
          error,
          summary: "Validation error",
        });
        await this.taskStore.moveTask(validationTaskId, "in-review");
        loopLog.log(`Moved validation task ${validationTaskId} to in-review`);
      }

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
