/**
 * Reviewer — spawns a separate pi agent to review a worker's plan or code.
 *
 * Replicates taskplane's cross-model review pattern:
 * - Worker calls review_step(step, type) during execution
 * - A separate reviewer agent is spawned with read-only tools
 * - Reviewer writes a structured verdict: APPROVE, REVISE, or RETHINK
 * - Verdict + feedback is returned to the worker
 */

import type { TaskStore } from "@kb/core";
import { createKbAgent } from "./pi.js";
import { AgentLogger } from "./agent-logger.js";
import { checkSessionError } from "./usage-limit-detector.js";

const REVIEWER_SYSTEM_PROMPT = `You are an independent code and plan reviewer.

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

### Do NOT issue REVISE for
- STATUS/formatting preferences
- Splitting outcome checkboxes into implementation sub-steps
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

### Suggestions
- [Optional improvements, not blocking]
\`\`\`

## Plan Granularity

When reviewing plans, assess whether the approach achieves the step's OUTCOMES —
not whether every function and parameter is listed.

Good plan: identifies key behavioral changes, calls out risks, has a testing strategy.
Do NOT demand function-level implementation checklists.

## Rules

- Be specific — reference actual files and line numbers
- Be constructive — suggest fixes, not just problems
- Be proportional — don't block on style nits
- Output your review as plain text (not to a file)
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
  /** Default thinking effort level for the reviewer agent session. */
  defaultThinkingLevel?: string;
  /** Task store for persisting agent log entries. When provided with `taskId`, enables full conversation logging. */
  store?: TaskStore;
  /** Task ID for agent log persistence. Required alongside `store`. */
  taskId?: string;
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
    taskId, stepNumber, stepName, reviewType, promptContent, cwd, baseline,
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

  // Spawn a reviewer agent with read-only tools
  const { session } = await createKbAgent({
    cwd,
    systemPrompt: REVIEWER_SYSTEM_PROMPT,
    tools: "readonly",
    onText: agentLogger ? agentLogger.onText : (delta) => options.onText?.(delta),
    onThinking: agentLogger?.onThinking,
    onToolStart: agentLogger?.onToolStart,
    onToolEnd: agentLogger?.onToolEnd,
    defaultProvider: options.defaultProvider,
    defaultModelId: options.defaultModelId,
    defaultThinkingLevel: options.defaultThinkingLevel,
  });

  let reviewText = "";

  // Capture the reviewer's full text output (still needed for verdict extraction)
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      reviewText += event.assistantMessageEvent.delta;
    }
  });

  try {
    await session.prompt(request);

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
  // Look for "### Verdict: APPROVE" or similar patterns
  const verdictMatch = review.match(
    /###?\s*Verdict[:\s]*(APPROVE|REVISE|RETHINK)/i,
  );
  if (verdictMatch) {
    return verdictMatch[1].toUpperCase() as ReviewVerdict;
  }

  // Fallback: look for the word anywhere in the text
  const upper = review.toUpperCase();
  if (upper.includes("RETHINK")) return "RETHINK";
  if (upper.includes("REVISE")) return "REVISE";
  if (upper.includes("APPROVE")) return "APPROVE";

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
