// port-4040-allowlist: reviewer prompts resolve from @fusion/core agent-prompts, which embeds the "never kill port 4040" rule.
/**
 * Reviewer — spawns a separate pi agent to review a worker's plan or code.
 *
 * Replicates taskplane's cross-model review pattern:
 * - Worker calls fn_review_step(step, type) during execution
 * - A separate reviewer agent is spawned with read-only tools
 * - Reviewer writes a structured verdict: APPROVE, REVISE, or RETHINK
 * - Verdict + feedback is returned to the worker
 */

import type { TaskStore, TaskComment, AgentPromptsConfig, Settings } from "@fusion/core";
import {
  buildReviewerMemoryInstructions,
  resolveAgentMemoryInclusionMode,
  resolveAgentPrompt,
  resolvePersistAgentThinkingLog,
  resolveTaskSeamPrompt,
} from "@fusion/core";
import { recordRetry } from "./retry-burned-logger.js";
import { mergeEffectiveSettings } from "./effective-settings.js";
import { describeModel, formatModelMarkerDetails, promptWithFallback } from "./pi.js";
import { isContextLimitError } from "./context-limit-detector.js";
import { classifyError } from "./transient-error-detector.js";
import { withRetry } from "./retry-with-backoff.js";
import { createResolvedAgentSession, extractRuntimeHint, resolveValidatorSessionModel } from "./agent-session-helpers.js";
import { buildSessionSkillContext } from "./session-skill-context.js";
import { AgentLogger } from "./agent-logger.js";
import { reviewerLog } from "./logger.js";
import { checkSessionError } from "./usage-limit-detector.js";
import {
  resolveAgentInstructions,
  buildPluginPromptSection,
} from "./agent-instructions.js";
import { buildPromptLayers, collapsePromptLayers } from "./prompt-layers.js";
import { createFallbackModelObserver } from "./fallback-model-observer.js";
import { createRunAuditor, generateSyntheticRunId } from "./run-audit.js";
import { createMemoryGetTool, createMemorySearchTool, createTaskPromptWriteTool, createWebFetchTool } from "./agent-tools.js";
import { buildUserCommentsPromptSection } from "./agent-user-comments.js";
import { resolveMcpServersForStore } from "./mcp-resolution.js";

export type ReviewType = "plan" | "code" | "spec";
export type ReviewVerdict = "APPROVE" | "REVISE" | "RETHINK" | "UNAVAILABLE";

/*
FNXC:ReviewerProviderErrors 2026-07-15-11:20:
A reviewer provider failure (rate limit / flaky network) is NOT a review verdict, and must never be laundered into `UNAVAILABLE`.

Root cause this type exists to fix: the reviewer was the only AI lane that never classified provider errors. A 429 became `UNAVAILABLE`, which drove the fallback ladder to re-hit the SAME rate-limited model instantly (when no validator fallback is configured the "fallback" is a same-model strict-prompt rerun), and `fn_review_step` then told the model "code review remains blocking; retry once", so the executor's agent re-called the tool indefinitely. Observed symptom: 14 identical "Reviewer using model: umans/umans-kimi-k2.7" markers with no review text, one per spawned session, hammering an already-limited provider.

`UNAVAILABLE` is reserved for its real meaning: the reviewer RAN and could not produce a parseable verdict. Provider failures throw this instead so they reach the machinery that already exists to handle them — `withRateLimitRetry` backoff, `UsageLimitPauser` global pause, and the executor's bounded transient recovery. See `getDeferredReviewerFatal` in executor.ts for why the escape needs a deferred re-raise.
*/
/** Bounded local retry budget for transient network blips inside one review attempt. */
const REVIEWER_TRANSIENT_MAX_RETRIES = 3;

export class ReviewerProviderError extends Error {
  constructor(
    message: string,
    /** `usage-limit` → global pause; `transient` → bounded recovery retry. Never `permanent`. */
    public readonly classification: "usage-limit" | "transient",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ReviewerProviderError";
  }
}

export interface ReviewResult {
  verdict: ReviewVerdict;
  review: string;
  summary: string;
}

export interface ReviewOptions {
  onText?: (delta: string) => void;
  /** Default model provider (e.g. "anthropic"). When set with `defaultModelId`, overrides the reviewer's model selection. */
  defaultProvider?: string;
  /** Default model ID within the provider (e.g. "claude-sonnet-4-5"). When set with `defaultProvider`, overrides the reviewer's model selection. */
  defaultModelId?: string;
  /** Task-level validator model provider override. When both provider and modelId are set, takes precedence over project/global lanes. */
  taskValidatorProvider?: string;
  /** Task-level validator model ID override. When both provider and modelId are set, takes precedence over project/global lanes. */
  taskValidatorModelId?: string;
  /** Project-level validator model provider override. Takes precedence over global validator lane. */
  projectValidatorProvider?: string;
  /** Project-level validator model ID override. Takes precedence over global validator lane. */
  projectValidatorModelId?: string;
  /** Global validator lane provider. Takes precedence over project default override + execution defaults. */
  globalValidatorProvider?: string;
  /** Global validator lane model ID. Takes precedence over project default override + execution defaults. */
  globalValidatorModelId?: string;
  /** Project-level default provider override, used when validator lanes are absent. */
  projectDefaultOverrideProvider?: string;
  /** Project-level default model override, used when validator lanes are absent. */
  projectDefaultOverrideModelId?: string;
  /** Fallback model provider used when the primary reviewer model hits a retryable provider-side error. */
  fallbackProvider?: string;
  /** Fallback model ID used with `fallbackProvider`. */
  fallbackModelId?: string;
  /** Project-level validator fallback provider override. Takes precedence over global fallback. */
  projectValidatorFallbackProvider?: string;
  /** Project-level validator fallback model ID override. Takes precedence over global fallback. */
  projectValidatorFallbackModelId?: string;
  /** Default thinking effort level for the reviewer agent session. */
  defaultThinkingLevel?: string;
  /**
   * FNXC:Settings-ThinkingLevel 2026-07-10-00:00:
   * Validator/reviewer sessions accept a fallback-specific thinking level so retryable fallback swaps preserve the selected fallback model's reasoning effort.
   */
  fallbackThinkingLevel?: string;
  /** Task store for persisting agent log entries. When provided with `taskId`, enables full conversation logging. */
  store?: TaskStore;
  /** Task ID for agent log persistence. Required alongside `store`. */
  taskId?: string;
  /** Optional reviewer agent id for retry-burn telemetry. */
  agentId?: string;
  /** Optional task title for fallback-used notification context. */
  taskTitle?: string;
  /** Task with optional assignedAgentId for skill selection. */
  task?: { assignedAgentId?: string | null };
  /** User comments on the task (author === "user"). For spec reviews, the reviewer explicitly checks that every comment is addressed. */
  userComments?: TaskComment[];
  /** Agent prompt configuration for resolving custom reviewer prompts. */
  agentPrompts?: AgentPromptsConfig;
  /** AgentStore for resolving per-agent custom instructions. */
  agentStore?: import("@fusion/core").AgentStore;
  /** Project root directory for resolving relative instructionsPath files. */
  rootDir?: string;
  /** Project settings used for backend-aware memory tools and instructions. */
  settings?: Settings;
  /** Plugin runner for runtime selection. When provided, enables plugin runtime lookup. */
  pluginRunner?: import("./plugin-runner.js").PluginRunner;
  /** Allow this reviewer to fix in-scope findings in the same session before returning its final verdict. */
  allowInlineFixes?: boolean;
  /*
  FNXC:TriagePlanReviewConvergence 2026-07-16-09:20:
  Spec-gate-only convergence context. The triage Plan Review gate feeds the reviewer its OWN
  prior REVISE feedback plus the 1-based replan attempt so a re-review VERIFIES its earlier
  issues were addressed instead of surfacing a fresh, deeper blocking issue every cycle
  (whack-a-mole/goalpost movement burned all 8 replans on FN-7996/FN-8105/FN-8108). Only
  injected when reviewType === "spec" and attempt > 1; CODE review and normal PLAN review are
  unaffected because these fields stay undefined on those paths.
  */
  priorSpecReviewFeedback?: string;
  /** 1-based current Plan Review attempt (= (task.planReviewReplanCount ?? 0) + 1). Spec gate only. */
  specReviewAttempt?: number;
  /**
   * Fired immediately after the reviewer's `AgentSession` is created. The
   * caller can register the session in a per-task subagent map so that the
   * session can be disposed when the parent task moves out of `in-progress`,
   * is paused, or the engine globally pauses. Without this hook, reviewer
   * sessions outlive their parent task on a stop signal.
   */
  onSessionCreated?: (session: import("@earendil-works/pi-coding-agent").AgentSession) => void;
  /**
   * Fired in a `finally` block after the reviewer is fully done (or aborted).
   * Pair with `onSessionCreated` to deregister from the subagent map.
   */
  onSessionEnded?: (session: import("@earendil-works/pi-coding-agent").AgentSession) => void;
}

function buildSameSessionFixPolicy(reviewType: ReviewType, canWritePrompt: boolean): string {
  const planSpecInstruction = canWritePrompt
    ? "- For plan/spec review, use fn_task_prompt_write with the complete revised PROMPT.md when the plan artifact needs repair. Do not implement product code from plan/spec review."
    : "- For plan/spec review, limit fixes to task-planning context available in this session. Do not implement product code from plan/spec review.";
  const codeInstruction = "- For code review, fix implementation issues inside the assigned task worktree and mention the fix in your review notes.";
  return `

## Same-Session Fix Policy

This review may fix issues it finds before returning a final verdict.
- If you find an in-scope issue you can fix safely, edit the relevant file(s) in this same reviewer session, run the smallest relevant verification, and then return APPROVE or APPROVE_WITH_NOTES.
- Return REVISE only when the issue is still present, cannot be safely fixed in this reviewer session, needs broader executor remediation, or needs user input.
${reviewType === "code" ? codeInstruction : planSpecInstruction}`;
}

function appendSameSessionFixPolicy(request: string, reviewType: ReviewType, canWritePrompt: boolean): string {
  return `${request}${buildSameSessionFixPolicy(reviewType, canWritePrompt)}`;
}

/**
 * Spawn a reviewer agent to evaluate a worker's plan or code for a step.
 *
 * FNXC:StepNumbering 2026-06-17-00:00:
 * `stepNumber` is display-only and must remain the same 0-based number shown in PROMPT.md (`### Step N:`). Review prompts, task logs, resume reconciliation, and loop-detection all compare this literal Step N string.
 */
export async function reviewStep(
  cwd: string,
  taskId: string,
  stepNumber: number,
  stepName: string,
  reviewType: ReviewType,
  promptContent: string,
  baseline?: string,
  options: ReviewOptions = {},
): Promise<ReviewResult> {
  // Pause gate: do not spawn a reviewer subprocess while the engine is paused.
  // Re-read settings from the store so a stale `options.settings` snapshot can't
  // leak a reviewer past a pause that flipped on after the parent agent started.
  let liveSettings: Settings | undefined = options.settings;
  if (options.store) {
    try {
      liveSettings = await options.store.getSettings();
    } catch {
      // Fall back to the snapshot — better to spawn than crash on a transient store error.
    }
  }
  if (liveSettings?.globalPause || liveSettings?.enginePaused) {
    const reason = liveSettings.globalPause ? "Global pause" : "Engine paused";
    reviewerLog.log(
      `${taskId}: ${reviewType} review for Step ${stepNumber} skipped — ${reason} active`,
    );
    if (options.store && options.taskId) {
      try {
        await options.store.logEntry(
          options.taskId,
          `${reviewType} review skipped — ${reason} active`,
        );
      } catch {
        // best-effort
      }
    }
    return {
      verdict: "UNAVAILABLE",
      review: `${reason} active — reviewer not spawned. Stop calling fn_review_* and exit cleanly; the parent task will resume after unpause.`,
      summary: `Skipped: ${reason}`,
    };
  }

  const canWritePromptInline =
    options.allowInlineFixes === true
    && reviewType !== "code"
    && Boolean(options.store && options.taskId);

  // FNXC:TriagePlanReviewConvergence 2026-07-16-09:20: spec-gate-only convergence context (see ReviewOptions).
  const specConvergence: SpecReviewConvergence | undefined =
    reviewType === "spec"
      ? { priorFeedback: options.priorSpecReviewFeedback, attempt: options.specReviewAttempt }
      : undefined;
  let request = buildReviewRequest(
    taskId, stepNumber, stepName, reviewType, promptContent, cwd, baseline, options.userComments, specConvergence,
  );
  if (options.allowInlineFixes === true) {
    /*
     * FNXC:WorkflowReviewers 2026-07-01-12:39:
     * Triage Plan Review uses this reviewer path instead of graph `executeWorkflowStep`. When workflow setting `reviewerInlineFixes` is enabled, the reviewer must be allowed to repair PROMPT.md/spec findings in this same session and return the final verdict after the fix.
     */
    request = appendSameSessionFixPolicy(request, reviewType, canWritePromptInline);
  }

  const effectiveSettings = liveSettings ?? options.settings;
  const agentLogger = options.store && options.taskId
    ? new AgentLogger({
        store: options.store,
        taskId: options.taskId,
        agent: "reviewer",
        onAgentText: options.onText
          ? (_id, delta) => options.onText!(delta)
          : undefined,
        persistAgentToolOutput: effectiveSettings?.persistAgentToolOutput,
        // Reviewer sessions are task-scoped ephemeral workers.
        persistAgentThinkingLog: resolvePersistAgentThinkingLog(effectiveSettings, { ephemeral: true }),
      })
    : null;

  /*
  FNXC:ModelResolution 2026-06-28-17:00:
  Reviewer, spec-review, and workflow review-step sessions are validator-lane sessions. Resolve their primary model through the shared session helper so task reviewer overrides, project/global validator lanes, project/global defaults, and test-mode mock forcing stay identical to core model resolution instead of drifting in a reviewer-local precedence chain.

  FNXC:ModelResolution 2026-06-28-17:48:
  Re-read store settings are the authoritative reviewer snapshot because optional review steps may omit `options.settings` or hold stale settings while test mode/default-provider mock has changed. Explicit per-call overrides still win, but every unspecified tier must come from the same live settings object passed into session creation.
  */
  const reviewerModelSettings: Partial<Settings> = {
    ...(effectiveSettings ?? {}),
    defaultProvider: options.defaultProvider ?? effectiveSettings?.defaultProvider,
    defaultModelId: options.defaultModelId ?? effectiveSettings?.defaultModelId,
    validatorProvider: options.projectValidatorProvider ?? effectiveSettings?.validatorProvider,
    validatorModelId: options.projectValidatorModelId ?? effectiveSettings?.validatorModelId,
    validatorGlobalProvider: options.globalValidatorProvider ?? effectiveSettings?.validatorGlobalProvider,
    validatorGlobalModelId: options.globalValidatorModelId ?? effectiveSettings?.validatorGlobalModelId,
    defaultProviderOverride: options.projectDefaultOverrideProvider ?? effectiveSettings?.defaultProviderOverride,
    defaultModelIdOverride: options.projectDefaultOverrideModelId ?? effectiveSettings?.defaultModelIdOverride,
  };
  const reviewerModel = resolveValidatorSessionModel(
    options.taskValidatorProvider,
    options.taskValidatorModelId,
    reviewerModelSettings,
  );
  const validatorProvider = reviewerModel.provider;
  const validatorModelId = reviewerModel.modelId;

  const validatorFallbackProvider = options.projectValidatorFallbackProvider && options.projectValidatorFallbackModelId
    ? options.projectValidatorFallbackProvider
    : options.fallbackProvider;
  const validatorFallbackModelId = options.projectValidatorFallbackProvider && options.projectValidatorFallbackModelId
    ? options.projectValidatorFallbackModelId
    : options.fallbackModelId;

  let reviewerInstructions = "";
  if (options.agentStore && options.rootDir) {
    try {
      const agents = await options.agentStore.listAgents({ role: "reviewer" });
      for (const agent of agents) {
        if (agent.instructionsText || agent.instructionsPath) {
          const memoryMode = resolveAgentMemoryInclusionMode({ agent, globalSettings: effectiveSettings }).mode;
          reviewerInstructions = await resolveAgentInstructions(agent, options.rootDir, undefined, memoryMode);
          break;
        }
      }
    } catch {
      // Graceful fallback
    }
  }
  const userReviewerPrompt = options.agentPrompts?.roleAssignments?.reviewer
    ? resolveAgentPrompt("reviewer", options.agentPrompts)
    : "";
  const workflowReviewerPrompt = options.store
    ? await resolveTaskSeamPrompt(options.store, taskId, "review").catch(() => undefined)
    : undefined;
  // FN-6235: built-in reviewer policy is sourced from the resolved workflow IR review node;
  // explicit reviewer role overrides still win, and the built-in default keeps this fail-soft.
  const reviewerBasePrompt = userReviewerPrompt || workflowReviewerPrompt || resolveAgentPrompt("reviewer");
  const memorySection = options.rootDir && effectiveSettings?.memoryEnabled !== false
    ? buildReviewerMemoryInstructions(options.rootDir, effectiveSettings)
    : "";

  const reviewerPluginContributions = await buildPluginPromptSection(
    "reviewer",
    options.pluginRunner,
  );
  if (reviewerPluginContributions) {
    reviewerLog.log(`applied plugin prompt contributions for reviewer surface`);
  }

  const layers = buildPromptLayers({
    basePrompt: reviewerBasePrompt,
    agentInstructions: reviewerInstructions,
    memorySection,
    pluginContributions: reviewerPluginContributions,
  });
  const reviewerSystemPromptFinal = collapsePromptLayers(layers);

  let skillContext = undefined;
  if (options.agentStore && options.rootDir) {
    try {
      skillContext = await buildSessionSkillContext({
        agentStore: options.agentStore,
        task: options.task ?? {},
        sessionPurpose: "reviewer",
        projectRootDir: options.rootDir,
        pluginRunner: options.pluginRunner,
      });
    } catch {
      // Graceful fallback - no skill selection
    }
  }

  const assignedAgentId = options.task?.assignedAgentId ?? null;
  const agentStore = options.agentStore;
  const memoryAgent =
    options.rootDir
    && agentStore
    && assignedAgentId
    && typeof (agentStore as { getAgent?: unknown }).getAgent === "function"
      ? await agentStore.getAgent(assignedAgentId).catch(() => null)
      : null;
  const memoryTools = options.rootDir && effectiveSettings?.memoryEnabled !== false
    ? [
        createMemorySearchTool(options.rootDir, effectiveSettings, memoryAgent ? {
          agentMemory: {
            agentId: memoryAgent.id,
            agentName: memoryAgent.name,
            memory: memoryAgent.memory,
          },
        } : undefined),
        createMemoryGetTool(options.rootDir, effectiveSettings, memoryAgent ? {
          agentMemory: {
            agentId: memoryAgent.id,
            agentName: memoryAgent.name,
            memory: memoryAgent.memory,
          },
        } : undefined),
      ]
    : undefined;
  class ReviewerPauseAbortError extends Error {
    constructor(public readonly reason: string) {
      super(`reviewer aborted: ${reason}`);
    }
  }

  const activeSessions = new Set<import("@earendil-works/pi-coding-agent").AgentSession>();
  let reviewText = "";

  const endSession = (session: import("@earendil-works/pi-coding-agent").AgentSession) => {
    if (!activeSessions.delete(session)) {
      return;
    }
    session.dispose();
    options.onSessionEnded?.(session);
  };

  const buildPauseUnavailableResult = async (reason: string): Promise<ReviewResult> => {
    reviewerLog.log(
      `${taskId}: ${reviewType} review for Step ${stepNumber} aborted before spawn — ${reason} active`,
    );
    if (options.store && options.taskId) {
      await options.store.logEntry(
        options.taskId,
        `${reviewType} review aborted before spawn — ${reason} active`,
      ).catch(() => undefined);
    }
    return {
      verdict: "UNAVAILABLE",
      review: `${reason} active — reviewer not spawned. Stop calling fn_review_* and exit cleanly; the parent task will resume after unpause.`,
      summary: `Skipped: ${reason}`,
    };
  };

  /*
  FNXC:ReviewerModelMarker 2026-07-15-11:20:
  The "Reviewer using model:" marker is emitted per SESSION CONSTRUCTION, and the dashboard resolves the reviewer's effective model by taking the LATEST matching marker (effective-model-resolution.ts). So the marker only carries information when the model CHANGES; re-emitting an identical marker for every retry of the same model tells operators nothing and is what turned a provider outage into 14 glued repetitions in the Chat tab.

  Dedupe on marker text, not on attempt count: a real fallback to a DIFFERENT model still emits (the model changed, so the dashboard must see it), while same-model retries stay silent. Scoped per reviewStep call so each review still records the model it actually ran on.
  */
  let lastEmittedModelMarker: string | undefined;

  const createReviewerSession = async (
    overrides?: { forceProvider?: string; forceModelId?: string },
  ): Promise<import("@earendil-works/pi-coding-agent").AgentSession> => {
    let streamReviewTextFromOnText = false;
    const handleReviewerText = (delta: string) => {
      if (streamReviewTextFromOnText) {
        reviewText += delta;
      }
      if (agentLogger) {
        agentLogger.onText(delta);
      } else {
        options.onText?.(delta);
      }
    };
    const runAuditor = options.store
      ? createRunAuditor(options.store, {
        runId: generateSyntheticRunId("reviewer", options.taskId ?? "review"),
        agentId: options.agentId ?? "reviewer",
        taskId: options.taskId,
        phase: "review",
        source: "reviewer",
      })
      : undefined;
    const reviewCustomTools = [
      createWebFetchTool(),
      ...(canWritePromptInline && options.store && options.taskId ? [createTaskPromptWriteTool(options.store, options.taskId)] : []),
      ...(memoryTools ?? []),
    ];

    const { session } = await createResolvedAgentSession({
      sessionPurpose: "reviewer",
      runtimeHint: extractRuntimeHint(memoryAgent?.runtimeConfig),
      pluginRunner: options.pluginRunner,
      cwd,
      systemPrompt: reviewerSystemPromptFinal,
      systemPromptLayers: layers,
      tools: options.allowInlineFixes === true && reviewType === "code" ? "coding" : "readonly",
      customTools: reviewCustomTools,
      onText: handleReviewerText,
      onThinking: agentLogger?.onThinking,
      onToolStart: agentLogger?.onToolStart,
      onToolEnd: agentLogger?.onToolEnd,
      defaultProvider: overrides?.forceProvider ?? validatorProvider,
      defaultModelId: overrides?.forceModelId ?? validatorModelId,
      fallbackProvider: validatorFallbackProvider,
      fallbackModelId: validatorFallbackModelId,
      fallbackThinkingLevel: options.fallbackThinkingLevel,
      defaultThinkingLevel: options.defaultThinkingLevel,
      runAuditor,
      settings: effectiveSettings,
      // FNXC:PluginSkills 2026-07-12-00:00: Reviewer sessions use the shared skill context; forward plugin body dirs so requested plugin review skills include their SKILL.md content.
      ...(skillContext?.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
      ...(skillContext && skillContext.additionalSkillPaths.length > 0 ? { additionalSkillPaths: skillContext.additionalSkillPaths } : {}),
      taskId: options.taskId,
      taskTitle: options.taskTitle,
      // FNXC:McpConfig 2026-06-25-22:45: Reviewer and validator sessions resolve the same trusted MCP server set as executor lanes at session creation; secret values are passed only in memory to the runtime guard.
      mcpServers: options.store ? (await resolveMcpServersForStore(options.store, { agentId: options.agentId })).servers : undefined,
      onFallbackModelUsed: createFallbackModelObserver({
        agent: "reviewer",
        label: "reviewer",
        store: options.store,
        taskId: options.taskId,
        taskTitle: options.taskTitle,
      }),
      beforeSpawnSession: async () => {
        if (!options.store) return;
        let finalSettings: Settings | undefined;
        try {
          finalSettings = await options.store.getSettings();
        } catch {
          return;
        }
        if (finalSettings?.globalPause || finalSettings?.enginePaused) {
          const reason = finalSettings.globalPause ? "Global pause" : "Engine paused";
          throw new ReviewerPauseAbortError(reason);
        }
      },
    });

    const reviewerModelDesc = describeModel(session);
    const reviewerModelDetails = formatModelMarkerDetails(reviewerModelDesc, options.defaultThinkingLevel);
    const reviewerModelMarker = `Reviewer using model: ${reviewerModelDetails}`;
    reviewerLog.log(`${taskId}: reviewer using model ${reviewerModelDetails}`);
    if (options.store && options.taskId && reviewerModelMarker !== lastEmittedModelMarker) {
      lastEmittedModelMarker = reviewerModelMarker;
      await options.store.logEntry(options.taskId, reviewerModelMarker);
      await options.store.appendAgentLog(options.taskId, reviewerModelMarker, "status", undefined, "reviewer").catch(() => undefined);
    }

    activeSessions.add(session);
    options.onSessionCreated?.(session);
    if (typeof session.subscribe === "function") {
      session.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          reviewText += event.assistantMessageEvent.delta;
        }
      });
    } else {
      streamReviewTextFromOnText = true;
    }

    return session;
  };

  const runReviewPrompt = async (
    session: import("@earendil-works/pi-coding-agent").AgentSession,
    prompt: string,
  ): Promise<void> => {
    await promptWithFallback(session, prompt);
    checkSessionError(session);
  };

  const runAttemptOnce = async (
    attemptRequest: string,
    sessionOptions?: { forceProvider?: string; forceModelId?: string },
  ): Promise<{ verdict: ReviewVerdict; summary: string; review: string }> => {
    reviewText = "";
    let session: import("@earendil-works/pi-coding-agent").AgentSession;
    try {
      session = await createReviewerSession(sessionOptions);
    } catch (err) {
      if (err instanceof ReviewerPauseAbortError) {
        return buildPauseUnavailableResult(err.reason);
      }
      throw err;
    }

    try {
      try {
        await runReviewPrompt(session, attemptRequest);
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        if (!isContextLimitError(errorMessage)) {
          throw err;
        }

        const retryLogMessage = reviewType === "code"
          ? "code review hit context limit — retrying with compacted request"
          : `${reviewType} review hit context limit — retrying with compacted request`;
        reviewerLog.warn(`${taskId}: ${retryLogMessage}`);
        if (options.store && options.taskId && retrySettings && typeof options.store.getTask === "function") {
          await options.store.logEntry(options.taskId, retryLogMessage).catch(() => undefined);
          const taskForRetry = await options.store.getTask(options.taskId);
          await recordRetry({
            store: options.store,
            settings: retrySettings,
            task: taskForRetry,
            category: "reviewerContext",
            role: "reviewer",
            agentId: options.agentId,
          });
        }

        reviewText = "";
        // FNXC:TriagePlanReviewConvergence 2026-07-16-09:20: reuse the single `specConvergence`
        // computed above so the context-limit retry carries byte-identical spec convergence context.
        let reducedRequest = buildReducedReviewRequest(
          taskId, stepNumber, stepName, reviewType, promptContent, cwd, baseline, options.userComments, specConvergence,
        );
        if (options.allowInlineFixes === true) {
          reducedRequest = appendSameSessionFixPolicy(reducedRequest, reviewType, canWritePromptInline);
        }

        try {
          await runReviewPrompt(session, reducedRequest);
        } catch (retryErr: unknown) {
          if (!isReviewerSessionReuseError(retryErr)) {
            throw retryErr;
          }

          endSession(session);
          try {
            session = await createReviewerSession(sessionOptions);
          } catch (recreateErr) {
            if (recreateErr instanceof ReviewerPauseAbortError) {
              return buildPauseUnavailableResult(recreateErr.reason);
            }
            throw recreateErr;
          }
          await runReviewPrompt(session, reducedRequest);
        }
      }
    } finally {
      if (agentLogger) {
        await agentLogger.flush();
      }
      for (const activeSession of [...activeSessions]) {
        endSession(activeSession);
      }
    }

    const verdict = extractVerdict(reviewText);
    const summary = extractSummary(reviewText);
    return { verdict, review: reviewText, summary };
  };

  /*
  FNXC:ReviewerTransientRetry 2026-07-15-11:20:
  A flaky network must degrade gracefully, not bounce the task. A dropped socket / gateway blip during a review is a temporary infrastructure condition, so absorb it HERE with exponential backoff + jitter rather than surfacing it as a failed review: a whole-attempt retry gets a clean session and a clean `reviewText` buffer (a half-streamed response would otherwise poison verdict extraction).

  Deliberately NOT a retry-storm: `withRetry` re-throws usage-limit errors immediately without sleeping (rate limits need the global pause, not a local retry that re-hits the limited provider), and re-throws permanent errors immediately (a genuinely broken review must reach the fallback ladder, not spin). Only `classifyError() === "transient"` retries, capped and with jitter so concurrent reviewers do not thunder.

  Backoff is short (2s base) relative to the executor's rate-limit curve (30s base) because a network blip resolves in seconds while a rate limit needs a real cooldown.
  */
  const runAttempt = async (
    attemptRequest: string,
    sessionOptions?: { forceProvider?: string; forceModelId?: string },
  ): Promise<{ verdict: ReviewVerdict; summary: string; review: string }> =>
    withRetry(() => runAttemptOnce(attemptRequest, sessionOptions), {
      maxRetries: REVIEWER_TRANSIENT_MAX_RETRIES,
      baseDelayMs: 2_000,
      maxDelayMs: 30_000,
      jitter: "full",
      isRetryable: (err) => classifyError(err instanceof Error ? err.message : String(err)) === "transient",
      onRetry: (attempt, delayMs, error) => {
        const message = `${reviewType} review hit a transient network error — retry ${attempt}/${REVIEWER_TRANSIENT_MAX_RETRIES} in ${Math.round(delayMs / 1000)}s: ${error.message}`;
        reviewerLog.warn(`${taskId}: ${message}`);
        if (options.store && options.taskId) {
          void options.store.logEntry(options.taskId, message).catch(() => undefined);
        }
      },
    });

  const fallbackReviewRequest = `${request}\n\nIMPORTANT: Respond with exactly one of: APPROVE | REVISE | RETHINK on a line starting with "Verdict:".`;

  const logFallbackRetry = async (reason: string, mode: string): Promise<void> => {
    const message = `${reviewType} review retry with fallback model after ${reason} (${mode})`;
    reviewerLog.warn(`${taskId}: ${message}`);
    if (options.store && options.taskId) {
      await options.store.logEntry(options.taskId, message).catch(() => undefined);
    }
  };

  const hasConfiguredFallback = Boolean(validatorFallbackProvider && validatorFallbackModelId);
  // Merge per-task effective workflow settings (U3, KTD-3) over the base so the
  // retry-budget reads (maxReviewerContextRetries / maxReviewerFallbackRetries via
  // recordRetry) pick up workflow values. `liveSettings`/`options.settings` are the
  // base; the merge is behavior-inert when nothing is customized. Resolved once
  // here (all recordRetry sites share it).
  const retrySettingsBase = liveSettings ?? options.settings;
  let retrySettings = retrySettingsBase;
  if (options.store && options.taskId && retrySettingsBase) {
    try {
      const retryTask = await options.store.getTask(options.taskId);
      retrySettings = await mergeEffectiveSettings(options.store, retryTask, retrySettingsBase);
    } catch {
      // Keep the base snapshot on any store/resolve error (never-throw).
    }
  }

  const resetReviewerFallbackRetryCount = async (): Promise<void> => {
    if (!options.store || !options.taskId || typeof options.store.updateTask !== "function") {
      return;
    }
    await options.store.updateTask(options.taskId, { reviewerFallbackRetryCount: 0 }).catch(() => undefined);
  };

  let firstAttempt: { verdict: ReviewVerdict; summary: string; review: string };
  try {
    firstAttempt = await runAttempt(request);
  } catch (err) {
    /*
    FNXC:ReviewerProviderErrors 2026-07-15-11:20:
    Classify BEFORE the fallback ladder. The ladder's premise is "this model produced a bad review, try another prompt/model" — a premise that is false for provider failures and actively harmful for them:
      - usage-limit: the ladder's same-model strict-prompt rerun (taken whenever no validator fallback is configured) re-hits the exact model that just rate-limited us, with no delay. Escalate instead so `withRateLimitRetry` backs off and `UsageLimitPauser` pauses every lane.
      - transient: `runAttempt` already spent its bounded backoff budget above, so the network is genuinely down. Escalate to the executor's bounded recovery (requeue with delay) rather than burning the reviewer fallback budget on a dead link.
    Neither burns `reviewerFallbackRetryCount` — that budget exists to bound BAD REVIEWS, and spending it on an outage would fail tasks that have nothing wrong with them.
    */
    const providerErrorMessage = err instanceof Error ? err.message : String(err);
    const classification = classifyError(providerErrorMessage);
    if (classification === "usage-limit" || classification === "transient") {
      const escalationMessage = `${reviewType} review could not reach the model (${classification}) — escalating to the engine retry path: ${providerErrorMessage}`;
      reviewerLog.warn(`${taskId}: ${escalationMessage}`);
      if (options.store && options.taskId) {
        await options.store.logEntry(options.taskId, escalationMessage).catch(() => undefined);
      }
      throw new ReviewerProviderError(providerErrorMessage, classification, { cause: err });
    }

    if (hasConfiguredFallback) {
      await logFallbackRetry("reviewer error", `${validatorFallbackProvider}/${validatorFallbackModelId}`);
      if (options.store && options.taskId && retrySettings && typeof options.store.getTask === "function") {
        const taskForRetry = await options.store.getTask(options.taskId);
        await recordRetry({
          store: options.store,
          settings: retrySettings,
          task: taskForRetry,
          category: "reviewerFallback",
          role: "reviewer",
          agentId: options.agentId,
          cause: err,
        });
      }
      try {
        const fallbackResult = await runAttempt(request, {
          forceProvider: validatorFallbackProvider,
          forceModelId: validatorFallbackModelId,
        });
        if (fallbackResult.verdict !== "UNAVAILABLE") {
          await resetReviewerFallbackRetryCount();
        }
        return fallbackResult;
      } catch {
        throw err;
      }
    }

    await logFallbackRetry("reviewer error", "same-model strict prompt");
    if (options.store && options.taskId && retrySettings && typeof options.store.getTask === "function") {
      const taskForRetry = await options.store.getTask(options.taskId);
      await recordRetry({
        store: options.store,
        settings: retrySettings,
        task: taskForRetry,
        category: "reviewerFallback",
        role: "reviewer",
        agentId: options.agentId,
        cause: err,
      });
    }
    try {
      const fallbackResult = await runAttempt(fallbackReviewRequest);
      if (fallbackResult.verdict !== "UNAVAILABLE") {
        await resetReviewerFallbackRetryCount();
      }
      return fallbackResult;
    } catch {
      throw err;
    }
  }

  if (firstAttempt.verdict !== "UNAVAILABLE") {
    await resetReviewerFallbackRetryCount();
    return firstAttempt;
  }

  if (hasConfiguredFallback) {
    await logFallbackRetry("UNAVAILABLE verdict", `${validatorFallbackProvider}/${validatorFallbackModelId}`);
    if (options.store && options.taskId && retrySettings && typeof options.store.getTask === "function") {
      const taskForRetry = await options.store.getTask(options.taskId);
      await recordRetry({
        store: options.store,
        settings: retrySettings,
        task: taskForRetry,
        category: "reviewerFallback",
        role: "reviewer",
        agentId: options.agentId,
      });
    }
    const fallbackResult = await runAttempt(request, {
      forceProvider: validatorFallbackProvider,
      forceModelId: validatorFallbackModelId,
    });
    if (fallbackResult.verdict !== "UNAVAILABLE") {
      await resetReviewerFallbackRetryCount();
    }
    return fallbackResult;
  }

  await logFallbackRetry("UNAVAILABLE verdict", "same-model strict prompt");
  if (options.store && options.taskId && retrySettings && typeof options.store.getTask === "function") {
    const taskForRetry = await options.store.getTask(options.taskId);
    await recordRetry({
      store: options.store,
      settings: retrySettings,
      task: taskForRetry,
      category: "reviewerFallback",
      role: "reviewer",
      agentId: options.agentId,
    });
  }
  const fallbackResult = await runAttempt(fallbackReviewRequest);
  if (fallbackResult.verdict !== "UNAVAILABLE") {
    await resetReviewerFallbackRetryCount();
  }
  return fallbackResult;
}

function isReviewerSessionReuseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /prompt is in progress|session (?:is )?(?:closed|disposed|ended)|conversation already active/i.test(message);
}

function extractPromptSection(promptContent: string, sectionName: string): string {
  const heading = `## ${sectionName}`;
  const start = promptContent.indexOf(heading);
  if (start === -1) {
    return "";
  }

  const afterHeading = start + heading.length;
  const nextH2 = promptContent.indexOf("\n## ", afterHeading);
  const nextH1 = promptContent.indexOf("\n# ", afterHeading);
  const endCandidates = [nextH2, nextH1].filter((value) => value !== -1);
  const end = endCandidates.length > 0 ? Math.min(...endCandidates) : promptContent.length;
  return promptContent.slice(start, end).trim();
}

function summarizePromptSteps(promptContent: string): string {
  const stepTitles = Array.from(promptContent.matchAll(/^### Step \d+:.*$/gm), (match) => match[0].trim());
  if (stepTitles.length === 0) {
    return "";
  }

  return ["## Steps", ...stepTitles].join("\n");
}

function buildReducedTaskPromptSummary(promptContent: string): string {
  const firstSectionIndex = promptContent.indexOf("\n## ");
  const header = (firstSectionIndex === -1 ? promptContent : promptContent.slice(0, firstSectionIndex)).trim();
  const sections = [
    header,
    extractPromptSection(promptContent, "Mission"),
    extractPromptSection(promptContent, "Dependencies"),
    extractPromptSection(promptContent, "File Scope"),
    summarizePromptSteps(promptContent),
    "_... additional PROMPT.md sections omitted after context-limit retry ..._",
  ].filter(Boolean);

  return sections.join("\n\n").trim();
}

/*
FNXC:TriagePlanReviewConvergence 2026-07-16-09:20:
Spec-gate-only convergence context threaded into the review request. `priorFeedback` is the
reviewer's own most recent Plan Review REVISE text; `attempt` is the 1-based replan attempt.
Present only for reviewType === "spec"; drives the per-attempt convergence + severity-ratchet
block injected into the request so the re-review confirms prior issues rather than moving the
goalposts each cycle.
*/
interface SpecReviewConvergence {
  priorFeedback?: string;
  attempt?: number;
}

function buildReducedReviewRequest(
  taskId: string,
  stepNumber: number,
  stepName: string,
  reviewType: ReviewType,
  promptContent: string,
  cwd: string,
  baseline?: string,
  userComments?: TaskComment[],
  specConvergence?: SpecReviewConvergence,
): string {
  /*
  FNXC:AgentSteering 2026-06-30-17:09:
  Context-limit retries may compact PROMPT.md, but reviewer gates still must evaluate every explicit user requirement.
  Preserve the canonical user comments and legacy steering section on reduced prompts so mandatory and optional reviews do not approve work that ignored operator feedback.
  */
  return buildReviewRequest(
    taskId,
    stepNumber,
    stepName,
    reviewType,
    buildReducedTaskPromptSummary(promptContent),
    cwd,
    baseline,
    userComments,
    specConvergence,
  );
}

function buildReviewRequest(
  taskId: string,
  stepNumber: number,
  stepName: string,
  reviewType: ReviewType,
  promptContent: string,
  cwd: string,
  baseline?: string,
  userComments?: TaskComment[],
  specConvergence?: SpecReviewConvergence,
): string {
  const parts = [
    `Review request for task ${taskId}, Step ${stepNumber}: ${stepName}`,
    `Review type: **${reviewType}**`,
    "",
    "## Task PROMPT.md",
    "```markdown",
    promptContent,
    "```",
    "",
  ];

  if (reviewType === "spec") {
    /*
    FNXC:PlanReviewReplan 2026-07-15-11:15:
    Spec/Plan Review REVISE loops burn planner+reviewer turns when feedback is vague or
    when polish is treated as blocking. Prefer fix-and-APPROVE / Suggestions for non-
    blocking nits; when REVISE is required, list concrete PROMPT.md edits the planner can
    apply surgically so the next cycle converges.
    */
    parts.push(
      "## What to review",
      "Evaluate this PROMPT.md specification for completeness and quality.",
      "Assess against the spec quality criteria: mission clarity, step specificity/verifiability,",
      "file scope accuracy, dependency correctness, testing requirements, documentation completeness,",
      "dangling task-document references, and appropriate sizing/review level.",
      "For tasks integrating third-party tools, also verify canonical upstream repo URL, docs URL, release/download URL, binary/CLI name, and checksum or explicit upstream-pending-verification marker are present.",
      "",
      "Read relevant source files to verify the spec references real files, functions, and patterns.",
      "Check that steps have concrete, verifiable outcomes — not vague instructions.",
      "Ensure testing requirements demand real automated tests with assertions.",
      "",
      "## Convergence rules (blocking REVISE budget)",
      "- Prefer APPROVE or APPROVE_WITH_NOTES when the plan is executable; put polish and optional improvements under **Suggestions** only.",
      "- Issue REVISE only for blocking defects that would cause the implementor to redo work or violate a hard gate (missing Surface Enumeration / Symptom Verification for bug-class tasks, dangling task-document refs, untestable steps, missing mission, user comments ignored, external-integration evidence gaps when required).",
      "- When you REVISE, list each blocking fix as a concrete edit the planner can apply to this PROMPT.md (section + what to add/change). Do not request a full rewrite unless the approach is fundamentally wrong (RETHINK).",
      "- If same-session PROMPT.md repair is available and a fix is local, apply it and APPROVE rather than bouncing to another replan cycle.",
    );

    /*
    FNXC:TriagePlanReviewConvergence 2026-07-16-09:20:
    On replan attempt > 1 the reviewer is re-reviewing a spec IT already rejected. Feed it the
    prior REVISE text and attempt number so it verifies those issues were addressed instead of
    surfacing a fresh deeper issue each cycle (the whack-a-mole that burned all 8 replans on
    FN-7996/FN-8105/FN-8108). At attempt >= 3, ratchet severity: gate only on delivery-blocking
    `critical` issues so a spec that is executable (executor + code review are later gates) does
    not loop on wording nits.
    */
    const specAttempt = specConvergence?.attempt ?? 0;
    if (specAttempt > 1) {
      parts.push(
        "",
        `## Convergence — Plan Review attempt ${specAttempt}`,
        `You (the reviewer) already reviewed an earlier version of this spec; the planner has since revised the PROMPT.md above. This is attempt ${specAttempt}.`,
        "- VERIFY each issue you raised previously was addressed. REVISE only if (a) a PRIOR blocking issue is still unresolved, or (b) this revision introduced a GENUINELY NEW problem.",
        "- Do NOT introduce a new blocking issue that ALSO applied to the version you previously reviewed — that is your own earlier miss; record it under **Suggestions**, not REVISE.",
      );
      const priorFeedback = specConvergence?.priorFeedback?.trim();
      if (priorFeedback) {
        parts.push(
          "",
          "Your prior Plan Review feedback (confirm each item is resolved):",
          "```",
          priorFeedback,
          "```",
        );
      }
      if (specAttempt >= 3) {
        parts.push(
          "",
          "### Severity ratchet (attempt 3+)",
          "Gate ONLY on `critical` (delivery-blocking) issues. Downgrade lone `important`/`minor` spec-wording nits to **Suggestions** and APPROVE. Rationale: the executor and downstream code review are later gates; a spec need not be perfect to be executable.",
        );
      }
    }

    // Add user comment coverage check for spec reviews
    if (userComments && userComments.length > 0) {
      parts.push(
        "",
        "## User Comment Coverage (MANDATORY)",
        "",
        "The following user comments were posted on this task. You MUST verify that the spec addresses **every** comment. If any user comment is not reflected or addressed in the PROMPT.md, issue a REVISE verdict.",
        "",
      );
      for (const comment of userComments) {
        const date = comment.updatedAt || comment.createdAt;
        parts.push(`- **[${date}]** ${comment.text}`);
      }
      parts.push(
        "",
        "Check each comment above against the spec content. Missing coverage for any user comment is a blocking issue.",
      );
    }
  } else if (reviewType === "plan") {
    parts.push(
      "## What to review",
      `The worker is about to implement Step ${stepNumber} (${stepName}).`,
      "Assess whether the step's checkboxes will achieve the stated outcomes.",
      "Read relevant source files to understand the current codebase state.",
      "Check for risks, missing edge cases, and gaps in the plan.",
    );
    const userCommentsSection = buildUserCommentsPromptSection(userComments ?? [], {
      intro: "The following user comments were posted on this task. Account for this feedback when assessing the plan; raise concerns when the plan conflicts with or ignores relevant user feedback.",
    });
    if (userCommentsSection) {
      parts.push("", userCommentsSection);
    }
  } else {
    parts.push(
      "## What to review",
      `The worker has implemented Step ${stepNumber} (${stepName}).`,
      "Review the code changes for correctness, patterns, and test coverage.",
      "",
      "## Worktree Boundary",
      `Assigned task worktree: \`${cwd}\``,
      "Verify that implementation changes are in this worktree. If you find changes or commits in the primary project checkout or any other path, issue REVISE unless the outside path is an expected project-root exception such as .fusion/memory/ files, task attachments, or explicitly documented Fusion metadata.",
      "",
    );
    const userCommentsSection = buildUserCommentsPromptSection(userComments ?? [], {
      intro: "The following user comments were posted on this task. Account for this feedback when reviewing the code; raise concerns when the implementation conflicts with or ignores relevant user feedback.",
    });
    if (userCommentsSection) {
      parts.push(userCommentsSection, "");
    }
    if (baseline) {
      parts.push(
        "To see the changes for this step, run:",
        `\`\`\`bash`,
        `git diff ${baseline}..HEAD`,
        `\`\`\``,
      );
    } else {
      parts.push(
        "To see recent changes, run:",
        "```bash",
        "git diff HEAD~1",
        "```",
      );
    }
  }

  parts.push(
    "",
    "## Instructions",
    "1. Read the relevant source files",
    "2. Assess the work against the task requirements",
    "3. Output your review using the format from your system prompt",
    "4. Be specific with file paths and line numbers",
  );

  return parts.join("\n");
}

/*
FNXC:ReviewLeniency 2026-07-01-22:15:
Operators want a review whose text CLEARLY approves to PASS even when the output is not perfectly structured — no trailing JSON verdict block and no "Verdict:" line. This detects an explicit prose approval while refusing to flip a rejection: any REVISE/RETHINK/"request revision|changes"/reject/disapprove or negated-approval ("not/no/never/cannot/can't/don't/doesn't/won't/without approve") signal disqualifies the lenient pass, so a prose REJECTION is never silently promoted to APPROVE. The positive set is a superset of the historical approve/approved/looks good/no issues/out of scope keywords plus common approval phrasings (approving, approval, LGTM, ship it, passes review, all good, acceptable, good to go/merge, no blocking issues/concerns).

Shared by the reviewer/plan-review parser (extractVerdict, this file) and the code-review + browser-verification gate parser (inferWorkflowStepVerdictFromProse in executor.ts). Fail-closed merge / PR-review / mission-verification gates deliberately do NOT use this — leniently reading "approved" out of malformed output there could auto-merge on garbage.
*/
export function proseSignalsClearApproval(rawOutput: string): boolean {
  const text = rawOutput.trim();
  if (text.length === 0) return false;
  // Revise/rethink/reject/needs-changes markers AND polite change-request
  // phrasings ("must be fixed", "please fix", "should be corrected", "want X
  // changed", "... before merging") disqualify leniency — a review that praises
  // one aspect but requests a change is a REVISE, not an approval. "blocking" is
  // intentionally NOT a marker: it appears in the approval phrase "no blocking
  // issues".
  const blockingSignal = new RegExp(
    [
      /\bREVIS(?:E|ED|ES|ING|ION|IONS)\b/,
      /\bRETHINK\b/,
      /\bREQUEST(?:ING|ED)?\s+(?:REVISION|CHANGES?)\b/,
      /\bNEEDS?\s+(?:REVISION|CHANGES?|WORK|FIXE?S?)\b/,
      /\bMUST\s+(?:BE\s+)?(?:FIX|CHANG|CORRECT|ADDRESS|RESOLV|UPDAT)\w*/,
      /\bSHOULD\s+(?:BE\s+)?(?:FIX|CHANG|CORRECT|ADDRESS|RESOLV|UPDAT|REVIS)\w*/,
      /\bPLEASE\s+(?:FIX|CHANG|CORRECT|ADDRESS|UPDAT|REVIS)\w*/,
      /\bWANTS?\s+(?:\w+\s+){0,3}?(?:CHANG|FIX|CORRECT|ADDRESS|REVIS)\w*/,
      /\bBEFORE\s+MERG\w*/,
      /\bREJECT(?:ED|ING|S)?\b/,
      /\bDISAPPROVE\b/,
    ].map((r) => r.source).join("|"),
    "i",
  );
  const negatedApproval =
    /\b(?:not|no|never|cannot|can['’]?t|don['’]?t|doesn['’]?t|won['’]?t|without)\s+approv/i;
  if (blockingSignal.test(text) || negatedApproval.test(text)) return false;
  // NOTE: "passes" is anchored to "passes review" — a bare "pass"/"passes"
  // matches unrelated "the tests/build pass", "pass on approving", etc., which
  // are not review approvals.
  const approvalSignal =
    /\b(?:approv(?:e|ed|es|ing|al)|approve[_\s]with[_\s]notes|looks?\s+good|lgtm|ship\s+it|no\s+(?:blocking\s+)?(?:issues|concerns|problems|objections)|passes?\s+(?:the\s+)?review|all\s+good|acceptable|good\s+to\s+(?:go|merge)|out\s+of\s+scope)\b/i;
  return approvalSignal.test(text);
}

/*
FNXC:ReviewLeniency 2026-07-01-23:30:
Some models emit PROSE followed by a trailing JSON payload — e.g. a paragraph of reasoning, then `{"verdict":"APPROVE","notes":"..."}` at the very end. Extract balanced top-level `{...}` objects in document order, string/escape aware so a brace inside prose or a notes string does not miscount. Callers prefer the LAST candidate as the authoritative trailing verdict. Shared by extractVerdict (reviewer/plan-review) and parseWorkflowStepVerdict (code-review + browser-verification gate).
*/
export function extractJsonObjectCandidates(text: string): string[] {
  const out: string[] = [];
  const starts: number[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") starts.push(i);
    else if (ch === "}") {
      const start = starts.pop();
      if (start !== undefined && starts.length === 0) out.push(text.slice(start, i + 1));
    }
  }
  return out;
}

/*
FNXC:ReviewLeniency 2026-07-01-23:30:
"Any approved" — classify a verdict TOKEN leniently so approval-family variants all pass. Any token starting with APPROVE (APPROVE, APPROVED, APPROVE_WITH_NOTES, approve_with_verdict, …) → APPROVE; REVISE/REQUEST_REVISION/REJECT → REVISE; RETHINK → RETHINK. Unknown tokens (e.g. "PASS") → null so callers can fall through instead of misclassifying.
*/
export function classifyReviewVerdictToken(raw: string): ReviewVerdict | null {
  const v = raw.trim().toUpperCase();
  if (v.startsWith("APPROVE") || v.startsWith("APPROVAL")) return "APPROVE";
  if (v.startsWith("REVISE") || v.startsWith("REQUEST_REVISION") || v.startsWith("REJECT")) return "REVISE";
  if (v.startsWith("RETHINK")) return "RETHINK";
  return null;
}

function extractVerdict(review: string): ReviewVerdict {
  /*
  FNXC:ReviewLeniency 2026-07-02-00:10:
  An EXPLICIT verdict the reviewer wrote as a heading or "Verdict:" line takes precedence over any JSON object found in the body. A reviewer that writes `## Verdict: REVISE` and also pastes a format example ```json {"verdict":"APPROVE"}``` or quotes a prior reviewer's `{"verdict":"APPROVE"}` must NOT be read as APPROVE. The prose→trailing-JSON case the leniency targets has no such heading/line, so JSON is still reached and used.
  */
  // Strategy 1: verdict in a heading line (### Verdict: APPROVE, **Verdict: REVISE**).
  // Only match lines that START with a verdict pattern to avoid matching keywords in body text.
  // Capture the whole token (e.g. APPROVE_WITH_NOTES) and classify leniently ("any approved").
  const headingMatch = review.match(
    /^[>\s]*(?:###?\s*|[*_]{1,2})Verdict[:\s]*[*_]{0,2}\s*([A-Za-z_]+)/im,
  );
  if (headingMatch) {
    const classified = classifyReviewVerdictToken(headingMatch[1]);
    if (classified) return classified;
  }

  // Strategy 2: Standalone verdict line like "Verdict: APPROVE" or "Decision: REVISE"
  const lineFallback = review.match(
    /^[>\s]*(?:verdict|decision)\s*[-:]\s*([A-Za-z_]+)/im,
  );
  if (lineFallback) {
    const classified = classifyReviewVerdictToken(lineFallback[1]);
    if (classified) return classified;
  }

  // Strategy 3: JSON verdict payload (structured output), tolerating prose before
  // it, extra fields (notes), and approval-family verdict variants. Prefer the
  // LAST balanced object — models emit the authoritative verdict as a trailing
  // JSON payload after any reasoning prose.
  const jsonCandidates = extractJsonObjectCandidates(review);
  for (let i = jsonCandidates.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(jsonCandidates[i]) as { verdict?: unknown };
      if (typeof parsed?.verdict === "string") {
        const classified = classifyReviewVerdictToken(parsed.verdict);
        if (classified) {
          reviewerLog.log(`Verdict extracted via JSON payload: ${classified}`);
          return classified;
        }
      }
    } catch {
      // Not valid JSON — try the next candidate / fall through to prose strategies.
    }
  }

  // Strategy 4 (lenient): no structured verdict, but the prose clearly approves
  // (and carries no revise/reject/negated-approval signal). Treat as APPROVE so
  // an imperfectly-structured approval passes instead of collapsing to a
  // synthetic UNAVAILABLE retry/block. See proseSignalsClearApproval.
  if (proseSignalsClearApproval(review)) {
    reviewerLog.log(`Verdict extracted via lenient prose approval (${review.length} chars) → APPROVE`);
    return "APPROVE";
  }

  reviewerLog.warn(`Could not extract verdict from review (${review.length} chars). Returning UNAVAILABLE.`);
  return "UNAVAILABLE";
}

function extractSummary(review: string): string {
  const summaryMatch = review.match(
    /###?\s*Summary[:\s]*([\s\S]*?)(?=###|$)/i,
  );
  if (summaryMatch) {
    return summaryMatch[1].trim().slice(0, 500);
  }
  // Fallback: first paragraph
  const lines = review.split("\n").filter((l) => l.trim());
  return lines.slice(0, 3).join(" ").slice(0, 300);
}
