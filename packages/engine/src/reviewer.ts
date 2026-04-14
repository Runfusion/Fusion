/**
 * Reviewer — spawns a separate pi agent to review a worker's plan or code.
 *
 * Replicates taskplane's cross-model review pattern:
 * - Worker calls review_step(step, type) during execution
 * - A separate reviewer agent is spawned with read-only tools
 * - Reviewer writes a structured verdict: APPROVE, REVISE, or RETHINK
 * - Verdict + feedback is returned to the worker
 */

import type { TaskStore, TaskComment, AgentPromptsConfig } from "@fusion/core";
import { resolveAgentPrompt } from "@fusion/core";
import { createKbAgent, describeModel, promptWithFallback } from "./pi.js";
import { buildSessionSkillContext } from "./session-skill-context.js";
import { AgentLogger } from "./agent-logger.js";
import { reviewerLog } from "./logger.js";
import { checkSessionError } from "./usage-limit-detector.js";
import { resolveAgentInstructions, buildSystemPromptWithInstructions } from "./agent-instructions.js";

export const REVIEWER_SYSTEM_PROMPT = `You are an independent code and plan reviewer.

You provide quality assessment for task implementations. You have full read
access to the codebase and can run commands to inspect code.

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
- Necessary fixes outside the initial File Scope when they are required to restore green tests, build, or typecheck and do not delete/gut unrelated functionality
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
- **Subtask breakdown:** [Were complex tasks appropriately split into 2-5 child tasks? A task with 8+ implementation steps, affecting 3+ packages, should have been divided]
- **User comment coverage:** [Were all user comments addressed? Every user comment must be reflected in the spec — missing coverage is a blocking REVISE]

### Suggestions
- [Optional improvements, not blocking]
\`\`\`

## Spec Review — Undersplit Task Detection

When reviewing specs, actively assess whether the task should have been broken into subtasks:

**Flag as REVISE if:**
- A task has 8 or more implementation steps
- A task affects 3+ different packages but wasn't split
- A task has multiple clearly independent deliverables combined into one

**How to flag an undersplit task:**
Say explicitly: "This task should be broken into subtasks because [specific reason]."
Recommend the number of child tasks (2-5) and what each should cover.
**Critically**, instruct the planner to take these actions in your REVISE feedback:
1. Use the \`task_create\` tool to create 2–5 child tasks from the oversized spec
2. Do NOT write a parent PROMPT.md — the parent will be closed automatically after children are created
3. Each child task should cover one coherent deliverable with clear scope boundaries

Example REVISE feedback for an undersplit task:
"This task should be broken into 3 subtasks because it spans the engine, dashboard, and CLI packages with independent deliverables. Use task_create to create: (1) engine logic, (2) dashboard UI, (3) CLI integration. Do not write a parent PROMPT."

**Do NOT flag if:**
- Steps are sequential and tightly coupled (e.g., a pipeline where each step depends on the previous)
- The task has 5-7 steps but they're all within a single module/package
- Splitting would create coordination overhead that exceeds the benefit

## Plan Granularity

When reviewing plans, assess whether the approach achieves the step's OUTCOMES —
not whether every function and parameter is listed.

Good plan: identifies key behavioral changes, calls out risks, has a testing strategy.
Do NOT demand function-level implementation checklists.

## Worktree Boundary Review

For code reviews, verify that implementation changes are in the assigned task
worktree. The review request includes the current worktree path. Inspect git
state and recent commits from that worktree, and treat changes outside it as a
blocking REVISE unless they are expected project-root state such as
\`.fusion/memory.md\`, task attachments, or other explicitly documented
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
  /** Validator model provider override. When both `validatorModelProvider` and `validatorModelId` are set, they take precedence over `defaultProvider`/`defaultModelId`. */
  validatorModelProvider?: string;
  /** Validator model ID override. When both `validatorModelProvider` and `validatorModelId` are set, they take precedence over `defaultProvider`/`defaultModelId`. */
  validatorModelId?: string;
  /** Fallback model provider used when the primary reviewer model hits a retryable provider-side error. */
  fallbackProvider?: string;
  /** Fallback model ID used with `fallbackProvider`. */
  fallbackModelId?: string;
  /** Validator fallback model provider override. When both validator fallback fields are set, they take precedence over fallbackProvider/fallbackModelId. */
  validatorFallbackModelProvider?: string;
  /** Validator fallback model ID override. When both validator fallback fields are set, they take precedence over fallbackProvider/fallbackModelId. */
  validatorFallbackModelId?: string;
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

  // Resolve validator model settings: use per-task overrides if both provider and modelId are set,
  // otherwise fall back to defaultProvider/defaultModelId
  const validatorProvider = options.validatorModelProvider && options.validatorModelId
    ? options.validatorModelProvider
    : options.defaultProvider;
  const validatorModelId = options.validatorModelProvider && options.validatorModelId
    ? options.validatorModelId
    : options.defaultModelId;
  const validatorFallbackProvider = options.validatorFallbackModelProvider && options.validatorFallbackModelId
    ? options.validatorFallbackModelProvider
    : options.fallbackProvider;
  const validatorFallbackModelId = options.validatorFallbackModelProvider && options.validatorFallbackModelId
    ? options.validatorFallbackModelId
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
  const reviewerSystemPrompt = buildSystemPromptWithInstructions(
    resolveAgentPrompt("reviewer", options.agentPrompts) || REVIEWER_SYSTEM_PROMPT,
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
  const { session } = await createKbAgent({
    cwd,
    systemPrompt: reviewerSystemPrompt,
    tools: "readonly",
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
  });

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

  // Extract verdict from the review text
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
      "Verify that implementation changes are in this worktree. If you find changes or commits in the primary project checkout or any other path, issue REVISE unless the outside path is an expected project-root exception such as .fusion/memory.md, task attachments, or explicitly documented Fusion metadata.",
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
