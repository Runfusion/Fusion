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
import { buildReviewerMemoryInstructions, resolveAgentPrompt } from "@fusion/core";
import { describeModel, promptWithFallback } from "./pi.js";
import { createResolvedAgentSession, extractRuntimeHint } from "./agent-session-helpers.js";
import { buildSessionSkillContext } from "./session-skill-context.js";
import { AgentLogger } from "./agent-logger.js";
import { reviewerLog } from "./logger.js";
import { checkSessionError } from "./usage-limit-detector.js";
import { resolveAgentInstructions, buildSystemPromptWithInstructions } from "./agent-instructions.js";
import { createMemoryGetTool, createMemorySearchTool } from "./agent-tools.js";

export const REVIEWER_SYSTEM_PROMPT = `You are an independent code and plan reviewer.

## Your Role
You are an objective quality gate for plans, code, and specs.
You are neither the implementor's advocate nor adversary: your job is evidence-based assessment that protects delivery quality.

You provide quality assessment for task implementations. You have full read
access to the codebase and can run commands to inspect code.

## What to Look For
- Correctness against stated requirements
- Edge-case handling and failure-path behavior
- Test adequacy (behavior-focused coverage, meaningful assertions)
- Consistency with existing project patterns and conventions
- Security, data-safety, and permission boundary concerns
- Performance implications where changes affect hot paths or heavy operations

Review efficiently: prioritize high-impact correctness/risk issues first. Do not spend blocking attention on style nits when substantive defects exist.

## Verdict Criteria

- **APPROVE** — Step will achieve its stated outcomes. Minor suggestions go in
  the Suggestions section but do NOT block progress. If your only findings are
  minor or suggestion-level, verdict is APPROVE.
- **REVISE** — Step will fail, produce incorrect results, or miss a stated
  requirement without fixes. Use ONLY for issues that would cause the worker to
  redo work later.
- **RETHINK** — Approach is fundamentally wrong. Explain why and suggest an
  alternative.

### APPROVE vs REVISE

Concrete examples:
- APPROVE: implementation satisfies outcomes; only optional cleanup or minor wording suggestions remain.
- REVISE: a required behavior is missing, tests are insufficient for changed behavior, or a likely regression exists.
- RETHINK: the approach conflicts with architecture/task goals such that incremental edits are unlikely to rescue it.

**APPROVE** when:
- The approach will work, but you see a cleaner alternative
- Documentation style could improve
- You'd suggest additional tests but core coverage is adequate

**REVISE** when:
- A requirement from PROMPT.md will not be met
- A bug or regression is introduced
- A critical edge case is unhandled and would cause runtime failure
- Backward compatibility is broken without migration
- Code outside the task's File Scope is deleted, removed, or gutted (out-of-scope removal)
- Existing functionality is removed without a corresponding changeset explaining the removal
- Code changes were made outside the assigned task worktree, unless the path is an expected exception such as project memory or task attachments

### Do NOT issue REVISE for
- STATUS/formatting preferences
- Splitting outcome checkboxes into implementation sub-steps
- Necessary fixes outside the initial File Scope when they are required to restore green lint, tests, build, or typecheck and do not delete/gut unrelated functionality
- Suggestions that improve quality but aren't required for correctness

## Plan Review Format

\`\`\`markdown
## Plan Review: [Step Name]

### Verdict: [APPROVE | REVISE | RETHINK]

### Summary
[2-3 sentence assessment]

### Issues Found
1. **[Severity: critical/important/minor]** — [Description and suggested fix]

### Suggestions
- [Optional improvements, not blocking]
\`\`\`

## Code Review Format

\`\`\`markdown
## Code Review: [Step Name]

### Verdict: [APPROVE | REVISE | RETHINK]

### Summary
[2-3 sentence assessment]

### Issues Found
1. **[File:Line]** [Severity] — [Description and fix]

### Pattern Violations
- [Deviations from project standards]

### Test Gaps
- [Missing test scenarios]

### Suggestions
- [Optional improvements, not blocking]
\`\`\`

## Spec Review Format

\`\`\`markdown
## Spec Review: [Task ID]

### Verdict: [APPROVE | REVISE | RETHINK]

### Summary
[2-3 sentence assessment of the specification quality]

### Issues Found
1. **[Severity: critical/important/minor]** — [Description and suggested fix]

### Criteria Assessment
- **Mission clarity:** [Clear, unambiguous mission statement?]
- **Step specificity:** [Steps have verifiable, concrete outcomes?]
- **File scope accuracy:** [All affected files listed? No extras?]
- **Dependency correctness:** [Dependencies exist and are appropriate?]
- **Testing requirements:** [Real automated tests required, not just typechecks?]
- **Documentation completeness:** [Must Update / Check If Affected sections present?]
- **Sizing & review level:** [Size and review level appropriate for the work?]
- **Subtask breakdown:** [Only flag genuinely oversized specs (12+ implementation steps, OR 5+ truly independent deliverables that could ship separately). Do NOT flag a coherent vertical change just because it touches multiple packages. When borderline, prefer leaving the task whole.]
- **User comment coverage:** [Were all user comments addressed? Every user comment must be reflected in the spec — missing coverage is a blocking REVISE]

### Suggestions
- [Optional improvements, not blocking]
\`\`\`

## Spec Review — Undersplit Task Detection

When reviewing specs, assess whether the task should have been broken into subtasks. The bar for splitting is high — most tasks should remain whole. Coordination overhead (worktrees, dependency wiring, merge sequencing) is real, so splitting must clearly pay for itself.

**Default position:** do NOT flag undersplit. Reach for it only when the spec is genuinely oversized.

**Flag as REVISE only when ALL of the following are true:**
- The spec has 12+ implementation steps, OR contains 5+ clearly independent deliverables that could be shipped separately by different people
- The deliverables are NOT a coherent vertical change (a single feature touching core + dashboard + tests is coherent — do not split it)
- Splitting would produce children that each have ≥4 steps and a clearly distinct scope

If the spec is borderline (under those thresholds, or arguable), put your splitting suggestion in the **Suggestions** section instead of REVISE — the planner can take it or leave it.

**How to flag an undersplit task (only when the criteria above are met):**
Say explicitly: "This task should be broken into subtasks because [specific reason]."
Recommend the number of child tasks (2-5) and what each should cover.
Instruct the planner to:
1. Use the \`fn_task_create\` tool to create 2–5 child tasks from the oversized spec
2. Do NOT write a parent PROMPT.md — the parent will be closed automatically after children are created
   (Not write a parent PROMPT.md is also unacceptable.)
3. Make each child cover one coherent deliverable with clear scope boundaries

Example REVISE feedback for a genuinely oversized task:
"This task has 14 steps and contains 4 independent deliverables (engine integration, dashboard UI, CLI command, migration tooling) that could ship separately. Use fn_task_create to split into: (1) engine logic, (2) dashboard UI, (3) CLI integration, (4) migration tooling. Do not write a parent PROMPT."

**Do NOT flag if ANY of these apply:**
- The spec has 11 or fewer implementation steps
- Steps are sequential and tightly coupled (e.g., a pipeline where each step depends on the previous)
- The task is a vertical change touching multiple packages for one coherent feature (typical in this monorepo)
- The task is a bug fix, regardless of how many files it touches
- Splitting would create coordination overhead that exceeds the benefit

## Plan Granularity

When reviewing plans, assess whether the approach achieves the step's OUTCOMES —
not whether every function and parameter is listed.

Good plan: identifies key behavioral changes, calls out risks, has a testing strategy.
Do NOT demand function-level implementation checklists.

## Test Quality Review

When reviewing tests, check that they verify observable behavior and regression risk (not only implementation trivia).
Flag REVISE when key edge cases or failure modes for changed behavior are untested.

## Worktree Boundary Review

For code reviews, verify that implementation changes are in the assigned task
worktree. The review request includes the current worktree path. Inspect git
state and recent commits from that worktree, and treat changes outside it as a
blocking REVISE unless they are expected project-root state such as
\`.fusion/memory/\` files, task attachments, or other explicitly documented
Fusion metadata. If you see edits or commits in the primary project checkout
instead of the task worktree, call that out directly and ask the worker to move
the changes into the assigned worktree.

## Rules

- Be specific — reference actual files and line numbers
- Be constructive — suggest fixes, not just problems
- Be proportional — don't block on style nits
- Output your review as plain text (not to a file)
- **NEVER kill processes on port 4040.** Port 4040 is the production dashboard. If you need to test server endpoints, start a server on a different port (\`--port 0\` for random). If port 4040 is occupied, use a different port — do NOT kill the occupant. Issue REVISE if the executor kills or attempts to kill processes on port 4040.
`;

export type ReviewType = "plan" | "code" | "spec";
export type ReviewVerdict = "APPROVE" | "REVISE" | "RETHINK" | "UNAVAILABLE";

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
  /** Task store for persisting agent log entries. When provided with `taskId`, enables full conversation logging. */
  store?: TaskStore;
  /** Task ID for agent log persistence. Required alongside `store`. */
  taskId?: string;
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
}

/**
 * Spawn a reviewer agent to evaluate a worker's plan or code for a step.
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

  // Build the review request
  const request = buildReviewRequest(
    taskId, stepNumber, stepName, reviewType, promptContent, cwd, baseline, options.userComments,
  );

  // Create AgentLogger for reviewer if store is available
  const agentLogger = options.store && options.taskId
    ? new AgentLogger({
        store: options.store,
        taskId: options.taskId,
        agent: "reviewer",
        onAgentText: options.onText
          ? (_id, delta) => options.onText!(delta)
          : undefined,
      })
    : null;

  // Resolve validator model settings using canonical lane hierarchy:
  // 1. Task-level validator override pair (taskValidatorProvider + taskValidatorModelId)
  // 2. Project-level validator override pair (projectValidatorProvider + projectValidatorModelId)
  // 3. Global validator lane pair (globalValidatorProvider + globalValidatorModelId)
  // 4. Project default override pair (projectDefaultOverrideProvider + projectDefaultOverrideModelId)
  // 5. Execution default pair (defaultProvider + defaultModelId)
  const validatorProvider = options.taskValidatorProvider && options.taskValidatorModelId
    ? options.taskValidatorProvider
    : (options.projectValidatorProvider && options.projectValidatorModelId
        ? options.projectValidatorProvider
        : (options.globalValidatorProvider && options.globalValidatorModelId
            ? options.globalValidatorProvider
            : (options.projectDefaultOverrideProvider && options.projectDefaultOverrideModelId
                ? options.projectDefaultOverrideProvider
                : options.defaultProvider)));
  const validatorModelId = options.taskValidatorProvider && options.taskValidatorModelId
    ? options.taskValidatorModelId
    : (options.projectValidatorProvider && options.projectValidatorModelId
        ? options.projectValidatorModelId
        : (options.globalValidatorProvider && options.globalValidatorModelId
            ? options.globalValidatorModelId
            : (options.projectDefaultOverrideProvider && options.projectDefaultOverrideModelId
                ? options.projectDefaultOverrideModelId
                : options.defaultModelId)));

  // Resolve validator fallback using lane hierarchy:
  // 1. Project-level validator fallback (projectValidatorFallbackProvider + projectValidatorFallbackModelId)
  // 2. Execution fallback (fallbackProvider + fallbackModelId)
  const validatorFallbackProvider = options.projectValidatorFallbackProvider && options.projectValidatorFallbackModelId
    ? options.projectValidatorFallbackProvider
    : options.fallbackProvider;
  const validatorFallbackModelId = options.projectValidatorFallbackProvider && options.projectValidatorFallbackModelId
    ? options.projectValidatorFallbackModelId
    : options.fallbackModelId;

  // Resolve per-agent custom instructions for the reviewer role
  let reviewerInstructions = "";
  if (options.agentStore && options.rootDir) {
    try {
      const agents = await options.agentStore.listAgents({ role: "reviewer" });
      for (const agent of agents) {
        if (agent.instructionsText || agent.instructionsPath) {
          reviewerInstructions = await resolveAgentInstructions(agent, options.rootDir);
          break;
        }
      }
    } catch {
      // Graceful fallback
    }
  }
  const reviewerBasePrompt = resolveAgentPrompt("reviewer", options.agentPrompts) || REVIEWER_SYSTEM_PROMPT;
  const memorySection = options.rootDir && options.settings?.memoryEnabled !== false
    ? "\n" + buildReviewerMemoryInstructions(options.rootDir, options.settings)
    : "";
  const reviewerSystemPrompt = buildSystemPromptWithInstructions(
    reviewerBasePrompt + memorySection,
    reviewerInstructions,
  );

  // Build skill selection context (assigned agent skills take precedence over role fallback)
  let skillContext = undefined;
  if (options.agentStore && options.rootDir) {
    try {
      skillContext = await buildSessionSkillContext({
        agentStore: options.agentStore,
        task: options.task ?? {},
        sessionPurpose: "reviewer",
        projectRootDir: options.rootDir,
      });
    } catch {
      // Graceful fallback - no skill selection
    }
  }

  // Spawn a reviewer agent with read-only tools
  const assignedAgentId = options.task?.assignedAgentId ?? null;
  const agentStore = options.agentStore;
  const memoryAgent =
    options.rootDir
    && agentStore
    && assignedAgentId
    && typeof (agentStore as { getAgent?: unknown }).getAgent === "function"
      ? await agentStore.getAgent(assignedAgentId).catch(() => null)
      : null;
  const memoryTools = options.rootDir && options.settings?.memoryEnabled !== false
    ? [
        createMemorySearchTool(options.rootDir, options.settings, memoryAgent ? {
          agentMemory: {
            agentId: memoryAgent.id,
            agentName: memoryAgent.name,
            memory: memoryAgent.memory,
          },
        } : undefined),
        createMemoryGetTool(options.rootDir, options.settings, memoryAgent ? {
          agentMemory: {
            agentId: memoryAgent.id,
            agentName: memoryAgent.name,
            memory: memoryAgent.memory,
          },
        } : undefined),
      ]
    : undefined;
  // Sentinel error used by the beforeCreateSession hook to cancel session
  // creation when a pause is detected after runtime resolution but before
  // the LLM session is actually spawned. Caught locally and converted to an
  // UNAVAILABLE verdict.
  class ReviewerPauseAbortError extends Error {
    constructor(public readonly reason: string) {
      super(`reviewer aborted: ${reason}`);
    }
  }

  // Reviewers run within the parent agent's slot accounting via
  // semaphore.runNested at the call site. The session spawn itself includes
  // a last-chance pause check (beforeSpawnSession) that the runtime fires
  // immediately before the underlying LLM session is instantiated — past
  // every awaited setup step inside the runtime (provider registration,
  // resource loading, etc.). This closes the TOCTOU window where a pause
  // flipped during the setup chain.
  let session: import("@mariozechner/pi-coding-agent").AgentSession;
  try {
    ({ session } = await createResolvedAgentSession({
      sessionPurpose: "reviewer",
      runtimeHint: extractRuntimeHint(memoryAgent?.runtimeConfig),
      pluginRunner: options.pluginRunner,
      cwd,
      systemPrompt: reviewerSystemPrompt,
      tools: "readonly",
      customTools: memoryTools,
      onText: agentLogger ? agentLogger.onText : (delta) => options.onText?.(delta),
      onThinking: agentLogger?.onThinking,
      onToolStart: agentLogger?.onToolStart,
      onToolEnd: agentLogger?.onToolEnd,
      defaultProvider: validatorProvider,
      defaultModelId: validatorModelId,
      fallbackProvider: validatorFallbackProvider,
      fallbackModelId: validatorFallbackModelId,
      defaultThinkingLevel: options.defaultThinkingLevel,
      // Skill selection: use assigned agent skills if available, otherwise role fallback
      ...(skillContext?.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
      beforeSpawnSession: async () => {
        if (!options.store) return;
        let finalSettings: Settings | undefined;
        try {
          finalSettings = await options.store.getSettings();
        } catch {
          // Treat a transient store failure as "not paused" — better to
          // proceed than to block reviews on a flaky read.
          return;
        }
        if (finalSettings?.globalPause || finalSettings?.enginePaused) {
          const reason = finalSettings.globalPause ? "Global pause" : "Engine paused";
          throw new ReviewerPauseAbortError(reason);
        }
      },
    }));
  } catch (err) {
    if (err instanceof ReviewerPauseAbortError) {
      reviewerLog.log(
        `${taskId}: ${reviewType} review for Step ${stepNumber} aborted before spawn — ${err.reason} active`,
      );
      if (options.store && options.taskId) {
        await options.store.logEntry(
          options.taskId,
          `${reviewType} review aborted before spawn — ${err.reason} active`,
        ).catch(() => undefined);
      }
      return {
        verdict: "UNAVAILABLE",
        review: `${err.reason} active — reviewer not spawned. Stop calling fn_review_* and exit cleanly; the parent task will resume after unpause.`,
        summary: `Skipped: ${err.reason}`,
      };
    }
    throw err;
  }

  reviewerLog.log(`${taskId}: reviewer using model ${describeModel(session)}`);
  if (options.store && options.taskId) {
    await options.store.logEntry(options.taskId, `Reviewer using model: ${describeModel(session)}`);
  }

  let reviewText = "";

  // Capture the reviewer's full text output (still needed for verdict extraction)
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      reviewText += event.assistantMessageEvent.delta;
    }
  });

  try {
    await promptWithFallback(session, request);

    // Re-raise errors that pi-coding-agent swallowed after exhausting retries.
    // The caller (executor's createReviewStepTool) catches errors and returns
    // UNAVAILABLE, so the thrown error will be handled there.
    checkSessionError(session);
  } finally {
    if (agentLogger) await agentLogger.flush();
    session.dispose();
  }

  const verdict = extractVerdict(reviewText);
  const summary = extractSummary(reviewText);
  return { verdict, review: reviewText, summary };
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
    parts.push(
      "## What to review",
      "Evaluate this PROMPT.md specification for completeness and quality.",
      "Assess against the spec quality criteria: mission clarity, step specificity/verifiability,",
      "file scope accuracy, dependency correctness, testing requirements, documentation completeness,",
      "and appropriate sizing/review level.",
      "",
      "Read relevant source files to verify the spec references real files, functions, and patterns.",
      "Check that steps have concrete, verifiable outcomes — not vague instructions.",
      "Ensure testing requirements demand real automated tests with assertions.",
    );

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

function extractVerdict(review: string): ReviewVerdict {
  // Strategy 1: Look for a JSON verdict block (structured output)
  // Matches: ```json\n{"verdict": "APPROVE"}\n``` or inline {"verdict":"REVISE"}
  const jsonMatch = review.match(
    /\{\s*"verdict"\s*:\s*"(APPROVE|REVISE|RETHINK)"\s*\}/i,
  );
  if (jsonMatch) {
    reviewerLog.log(`Verdict extracted via JSON block: ${jsonMatch[1].toUpperCase()}`);
    return jsonMatch[1].toUpperCase() as ReviewVerdict;
  }

  // Strategy 2: Look for verdict in a heading line (### Verdict: APPROVE, **Verdict: REVISE**)
  // Only match lines that START with a verdict pattern to avoid matching keywords in body text
  const headingMatch = review.match(
    /^[>\s]*(?:###?\s*|[*_]{1,2})Verdict[:\s]*[*_]{0,2}\s*(APPROVE|REVISE|RETHINK)\b/im,
  );
  if (headingMatch) {
    return headingMatch[1].toUpperCase() as ReviewVerdict;
  }

  // Strategy 3: Standalone verdict line like "Verdict: APPROVE" or "Decision: REVISE"
  const lineFallback = review.match(
    /^[>\s]*(?:verdict|decision)\s*[-:]\s*(APPROVE|REVISE|RETHINK)\b/im,
  );
  if (lineFallback) {
    return lineFallback[1].toUpperCase() as ReviewVerdict;
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
