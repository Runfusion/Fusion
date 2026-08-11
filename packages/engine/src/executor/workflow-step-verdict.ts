/**
 * FNXC:CodeOrganization 2026-08-03-07:20:
 * Workflow-step conventions + verdict parsers peeled from executor.ts (wave18 / U4 Slice A).
 *
 * FNXC:PlanReviewNoOp 2026-08-09-22:10:
 * CLOSE_NO_OP is Plan Review only (FN-8841). Exact match + optionalGroupId gate so unrelated
 * review groups and prose cannot open a terminal lifecycle path.
 */
import { proseSignalsClearApproval, extractJsonObjectCandidates } from "../execution/reviewer.js";
import { normalizeWorkflowReviewFindings, PLAN_REVIEW_GROUP_ID, type WorkflowReviewFinding } from "@fusion/core";

/** Machine-readable workflow-step verdicts, including Plan Review CLOSE_NO_OP. */
export type WorkflowStepVerdict = "APPROVE" | "APPROVE_WITH_NOTES" | "REVISE" | "CLOSE_NO_OP";

/**
 * (U2 / KTD-2) Fusion workflow-step conventions preamble, prepended to a skill
 * step's prompt at the skill-prompt build path (runGraphCustomNode). It teaches
 * any bundled skill the conventions Fusion needs — in ONE engine-side place, so
 * the skills stay byte-for-byte upstream. The block is skill-agnostic and rides
 * on the node prompt; it deliberately overrides the upstream skill bodies that
 * still say "call AskUserQuestion" / "Task ce-*". Stable text — the await-input
 * grammar here must match `parseAwaitInputSentinel` and the persona-override
 * contract (fn_spawn_agent's `systemPromptOverride` param) verbatim.
 *
 * (U9 / KTD-7) The persona-fan-out instruction is path-confined: the skill must
 * resolve `<persona>.md` strictly within `$FUSION_CE_AGENTS_DIR` and reject any
 * `../` traversal before reading, since the file body is injected verbatim into a
 * child's system prompt (a filesystem prompt-injection surface otherwise).
 */
export const FUSION_WORKFLOW_STEP_CONVENTIONS_PREAMBLE = `## Fusion workflow-step conventions

You are running as a Fusion autonomous workflow step — NOT an interactive Claude Code session. Follow these conventions; they override any contrary instruction in the skill body below.

1. Asking the user: there is no interactive listener here. \`AskUserQuestion\` / \`request_user_input\` go into the void. When you must ask the user a question, emit EXACTLY ONE block of the form:
   ===FUSION_AWAIT_INPUT===
   <your question for the user>
   ===END_FUSION_AWAIT_INPUT===
   and then STOP. Fusion parks the task awaiting the user's answer and re-runs this step with their reply.

2. Headless runs: when the environment variable \`FUSION_HEADLESS=1\` is set, do NOT ask the user anything. Record a reasonable assumption explicitly in your output and proceed — never emit the await-input block in this mode.

3. Dispatching a \`ce-<persona>\` subagent: do NOT use a raw \`Task ce-*(...)\` call. Instead, read the persona definition from \`$FUSION_CE_AGENTS_DIR/<persona>.md\`, strip its YAML frontmatter, and pass the remaining body as the \`systemPromptOverride\` argument to the \`fn_spawn_agent\` tool. Resolve the path strictly inside \`$FUSION_CE_AGENTS_DIR\` — reject any \`<persona>\` containing \`/\` or \`..\` (path traversal), and skip a def whose body is empty or implausibly large. If \`fn_spawn_agent\` is not available (a readonly step), do the persona's work inline yourself instead of spawning.

`;

/**
 * Outcome of a single workflow step execution.
 * Supports three states: pass, hard failure, or revision requested with feedback.
 */
export interface WorkflowStepOutcome {
  success: boolean;
  revisionRequested?: boolean;
  output?: string;
  error?: string;
  /** Machine-readable verdict extracted from structured JSON output. */
  verdict?: WorkflowStepVerdict;
  /** Notes extracted from structured JSON output (distinct from raw output). */
  notes?: string;
  /** Normalized independently actionable feedback from a review-kind node. */
  findings?: WorkflowReviewFinding[];
  /** Set when the call exceeded `settings.workflowStepTimeoutMs`. Signals the
   *  caller to escalate to the fallback model rather than treat the failure
   *  as a generic revision request. */
  timedOut?: boolean;
  /** True when no structured or prose verdict could be inferred. */
  malformed?: boolean;
  /** Machine-readable graph failure used for deterministic recovery routing. */
  failureValue?: string;
}

/**
 * Result of running all pre-merge workflow steps.
 * Returns true if all passed, false if any hard failure, or a structured
 * revision result if a revision was requested.
 */
export type WorkflowStepResult =
  | { allPassed: true }
  | { allPassed: false; revisionRequested: false; feedback: string; stepName: string }
  | { allPassed: false; revisionRequested: true; feedback: string; stepName: string };

export function parseWorkflowStepVerdict(
  rawOutput: string,
  options: { optionalGroupId?: string } = {},
): { verdict: WorkflowStepVerdict; notes: string; findings?: WorkflowReviewFinding[] } | null {
  const trimmed = rawOutput.trim();
  const candidates: string[] = [];
  const fencedMatches = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  for (const match of fencedMatches) {
    candidates.push(match[1].trim());
  }
  /*
  FNXC:ReviewLeniency 2026-07-01-23:30:
  Prefer a balanced, string-aware object scan over a greedy `\{[\s\S]*\}` match: models that emit reasoning PROSE (which may itself contain braces) followed by a trailing `{"verdict":...}` payload broke the greedy span into invalid JSON. extractJsonObjectCandidates returns each top-level object in document order; iterating last→first prefers the trailing verdict payload.
  */
  candidates.push(...extractJsonObjectCandidates(trimmed));

  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(candidates[i]) as { verdict?: unknown; notes?: unknown; findings?: unknown };
      if (!parsed || typeof parsed.verdict !== "string") continue;
      /*
      FNXC:ReviewLeniency 2026-07-01-23:30:
      "Any approved" — accept approval-family verdict variants (APPROVE, APPROVED, APPROVE_WITH_NOTES, approve_with_verdict, …), not just the exact WORKFLOW_STEP_VERDICTS strings. A token starting with APPROVE maps to APPROVE_WITH_NOTES when it mentions notes, else APPROVE; REVISE-family → REVISE; anything else (e.g. "PASS") is not a verdict and the candidate is skipped.
      */
      const token = parsed.verdict.trim().toUpperCase();
      let verdict: WorkflowStepVerdict | null = null;
      if (token.startsWith("APPROVE") || token.startsWith("APPROVAL")) {
        verdict = token.includes("NOTE") ? "APPROVE_WITH_NOTES" : "APPROVE";
      } else if (token === "CLOSE_NO_OP" && options.optionalGroupId === PLAN_REVIEW_GROUP_ID) {
        /*
         * FNXC:PlanReviewNoOp 2026-08-09-01:17:
         * Only the built-in Plan Review protocol may request a no-op close. Exact matching
         * prevents prose or unrelated review groups from acquiring a terminal lifecycle path.
         */
        verdict = "CLOSE_NO_OP";
      } else if (token.startsWith("REVISE") || token.startsWith("REQUEST_REVISION") || token.startsWith("REJECT")) {
        verdict = "REVISE";
      }
      if (!verdict) continue;
      /*
      FNXC:WorkflowReviewFindings 2026-08-05-06:29:
      Review-kind prompt/script JSON may include a findings array. Normalize through core so invalid
      entries never poison the step outcome or Review-tab selection contract.
      */
      const findings = normalizeWorkflowReviewFindings(parsed.findings);
      return {
        verdict,
        notes: typeof parsed.notes === "string" ? parsed.notes : "",
        ...(findings ? { findings } : {}),
      };
    } catch {
      // continue
    }
  }

  return null;
}

export function inferWorkflowStepVerdictFromProse(rawOutput: string): { verdict: "APPROVE" | "APPROVE_WITH_NOTES" | "REVISE"; notes: string } | null {
  const trimmed = rawOutput.trim();
  const revisionMatch = trimmed.match(/^REQUEST REVISION\s*\n*/i);
  if (revisionMatch) {
    return { verdict: "REVISE", notes: trimmed.slice(revisionMatch[0].length).trim() || "Revision requested" };
  }
  /*
   * FNXC:PlanReview 2026-06-29-02:05:
   * Plan Review runs through reviewer-style agents that often emit a markdown
   * section such as `### Verdict: APPROVE` even when the prompt asks for trailing
   * JSON. Treat that explicit verdict as authoritative so a real approval does
   * not collapse into a synthetic pre-execution plan failure loop.
   */
  const explicitVerdictMatch = trimmed.match(/(?:^|\n)\s*(?:#{1,6}\s*)?(?:verdict|status)\s*:\s*(APPROVE_WITH_NOTES|APPROVE|REVISE)\b/i);
  if (explicitVerdictMatch) {
    return {
      verdict: explicitVerdictMatch[1].toUpperCase() as "APPROVE" | "APPROVE_WITH_NOTES" | "REVISE",
      notes: "",
    };
  }
  /*
  FNXC:ReviewLeniency 2026-07-01-22:15:
  A gate review (code-review, browser-verification) whose text clearly approves must PASS even when it is not perfectly structured. Delegate to the shared proseSignalsClearApproval detector so this parser and the reviewer/plan-review parser agree on what "clearly approved" means, and so a prose rejection ("not approved", "please revise", "reject") is never promoted to APPROVE. Replaces the prior narrow approve/approved/looks good/no issues/out of scope regex (now a subset of the shared detector).
  */
  if (proseSignalsClearApproval(trimmed)) {
    return { verdict: "APPROVE", notes: "" };
  }
  return null;
}

/**
 * FNXC:WorkflowGates 2026-06-17-18:22:
 * Gate-class workflow steps must emit a parseable JSON or prose verdict before they can approve pre-merge completion. A fully malformed response is surfaced explicitly so blocking gates fail while advisory gates can record a non-blocking advisory failure.
 */
/*
FNXC:CodeOrganization 2026-08-03-12:15:
PR #3317 nit: drop the incomplete overload set. The prior pair covered no-options and
{ requireVerdict: false } only, so { requireVerdict: true } failed to typecheck despite
being supported by the implementation. One optional-options signature is enough.
*/
export function parseWorkflowStepOutput(rawOutput: string, options: { requireVerdict?: boolean; optionalGroupId?: string } = {}): {
  output: string;
  verdict?: WorkflowStepVerdict;
  notes?: string;
  findings?: WorkflowReviewFinding[];
  malformed?: boolean;
} {
  const trimmed = rawOutput.trim();
  const parsed = parseWorkflowStepVerdict(trimmed, options);
  if (parsed) {
    return {
      output: parsed.notes || "",
      verdict: parsed.verdict,
      notes: parsed.notes,
      ...(parsed.findings ? { findings: parsed.findings } : {}),
    };
  }

  const inferred = inferWorkflowStepVerdictFromProse(trimmed);
  if (inferred) {
    return {
      output: inferred.notes || trimmed,
      verdict: inferred.verdict,
      notes: inferred.notes,
    };
  }

  if (options.requireVerdict === false) {
    return { output: trimmed };
  }

  return { output: trimmed, malformed: true };
}
