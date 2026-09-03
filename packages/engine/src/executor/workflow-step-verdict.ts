/**
 * FNXC:CodeOrganization 2026-08-03-07:20:
 * Workflow-step conventions + verdict parsers peeled from executor.ts (wave18 / U4 Slice A).
 *
 * FNXC:PlanReviewNoOp 2026-08-09-22:10:
 * CLOSE_NO_OP is Plan Review only (FN-8841). Exact match + optionalGroupId gate so unrelated
 * review groups and prose cannot open a terminal lifecycle path.
 */
import { proseSignalsClearApproval, extractJsonObjectCandidates, textHasStructuredVerdictKey } from "../execution/reviewer.js";
import { normalizeSupersededFindingIds, normalizeWorkflowReviewFindings, PLAN_REVIEW_GROUP_ID, type WorkflowReviewFinding, type WorkflowRepositoryReviewOutcome, type WorkflowStepNotRunReason } from "@fusion/core";

/** Machine-readable workflow-step verdicts, including Plan Review CLOSE_NO_OP. */
export type WorkflowStepVerdict = "APPROVE" | "APPROVE_WITH_NOTES" | "REVISE" | "CLOSE_NO_OP";

export type WorkflowStepMalformedReason =
  | "no-verdict"
  | "unreadable-structured-verdict"
  | "prose-approval-without-json";

export const MAX_DERIVED_WORKFLOW_STEP_NOTES_CHARS = 2_000;

/*
FNXC:ReviewVerdictAuthority 2026-09-02-19:16:
A verdict-required review may fail safely through prose REVISE, but only parsed structured JSON can authorize approval. Classify every missing-verdict response and narrate the protocol failure without inventing reviewer rationale so the card exposes why review did not complete.
*/
export function workflowStepMissingVerdictNotice(reason: WorkflowStepMalformedReason): string {
  const reasonText: Record<WorkflowStepMalformedReason, string> = {
    "no-verdict": "it emitted no structured JSON verdict object",
    "unreadable-structured-verdict": "its structured JSON verdict object was unreadable or invalid",
    "prose-approval-without-json": "its approval appeared only in prose without a structured JSON verdict object",
  };
  return `The review did not complete because ${reasonText[reason]}; no approval was recorded.`;
}

export const WORKFLOW_STEP_VERDICT_REPAIR_PROMPT = (optionalGroupId?: string): string => {
  const allowed = optionalGroupId === PLAN_REVIEW_GROUP_ID
    ? "APPROVE|APPROVE_WITH_NOTES|REVISE|CLOSE_NO_OP"
    : "APPROVE|APPROVE_WITH_NOTES|REVISE";
  return `Your previous answer did not contain a parseable verdict. Do not re-review the work and do not use tools. Reply with exactly one JSON object of the form {"verdict":"${allowed}"} and no other text. The verdict token must be one of the values shown exactly; a response with no verdict object is a failed review.`;
};

/** Read one verdict-only repair reply without inferring lifecycle authority from prose. */
export function parseWorkflowStepVerdictRepair(
  rawOutput: string,
  options: { optionalGroupId?: string } = {},
): WorkflowStepVerdict | null {
  return parseWorkflowStepVerdict(rawOutput, options)?.verdict ?? null;
}

export const WORKFLOW_STEP_NOTES_REPAIR_PROMPT = (verdict: WorkflowStepVerdict): string => `Your previous answer carried verdict ${verdict} with an empty notes field. Do not re-review the work and do not change the verdict. Reply with exactly one JSON object of the form {"notes":"..."} containing one to three sentences that name what you checked and why the verdict was reached. Use no tools.`;

export type WorkflowStepVerdictNoNotesReason = "empty" | "timed-out" | "failed-soft" | "unavailable" | "reused-empty";

/*
FNXC:ReviewVerdictNotes 2026-08-28-22:39:
FN-240 left the single-repository verdict lane without a terminal backstop when bounded note repair produced no text. Fusion narrates that protocol failure instead of failing the step because missing reviewer notes must not become a merge blocker, and it never fabricates reviewer rationale.
*/
export function workflowStepVerdictNoNotesNotice(
  verdict: WorkflowStepVerdict,
  reason: WorkflowStepVerdictNoNotesReason,
): string {
  const reasonText: Record<WorkflowStepVerdictNoNotesReason, string> = {
    empty: "the bounded notes follow-up returned no usable text",
    "timed-out": "the bounded notes follow-up timed out",
    "failed-soft": "the bounded notes follow-up failed",
    unavailable: "no bounded notes follow-up was available",
    "reused-empty": "the unchanged prior review record contained no usable notes",
  };
  return `The reviewer returned verdict ${verdict} without a rationale; ${reasonText[reason]}.`;
}

function boundWorkflowStepNotes(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= MAX_DERIVED_WORKFLOW_STEP_NOTES_CHARS) return trimmed;
  const prefix = trimmed.slice(0, MAX_DERIVED_WORKFLOW_STEP_NOTES_CHARS - 1);
  const lastWhitespace = prefix.search(/\s+\S*$/);
  return `${(lastWhitespace > 0 ? prefix.slice(0, lastWhitespace) : prefix).trimEnd()}…`;
}

function carriesStructuredVerdict(candidate: string): boolean {
  try {
    const parsed = JSON.parse(candidate) as unknown;
    return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.hasOwn(parsed, "verdict"));
  } catch {
    return false;
  }
}

/** Remove machine-readable verdict payloads while retaining the reviewer's surrounding prose. */
export function stripStructuredVerdictPayload(rawOutput: string): string {
  let remainder = rawOutput.replace(/```(?:json)?\s*([\s\S]*?)```/gi, (block, contents: string) => (
    carriesStructuredVerdict(contents.trim()) ? "" : block
  ));
  const verdictObjects = extractJsonObjectCandidates(remainder)
    .filter(carriesStructuredVerdict)
    .sort((left, right) => right.length - left.length);
  for (const candidate of verdictObjects) remainder = remainder.split(candidate).join("");
  return remainder.trim();
}

/** Derive bounded human-readable notes only from text the reviewer already authored. */
export function deriveWorkflowStepNotes(input: {
  rawOutput: string;
  verdict: WorkflowStepVerdict;
  notes: string;
  findings?: WorkflowReviewFinding[];
}): string | undefined {
  const explicit = boundWorkflowStepNotes(input.notes);
  if (explicit) return explicit;
  if (input.verdict === "CLOSE_NO_OP") return undefined;
  const prose = boundWorkflowStepNotes(stripStructuredVerdictPayload(input.rawOutput));
  if (prose) return prose;
  const findingSummary = input.findings?.map((finding) => `- ${finding.title.trim()}`).filter((line) => line !== "- ").join("\n");
  return findingSummary ? boundWorkflowStepNotes(findingSummary) : undefined;
}

/** Read one same-session repair reply without allowing it to replace the decided verdict. */
export function parseWorkflowStepNotesRepair(rawOutput: string, verdict: WorkflowStepVerdict): string | undefined {
  const candidates = extractJsonObjectCandidates(rawOutput);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(candidates[index]) as { notes?: unknown };
      if (typeof parsed.notes !== "string") continue;
      const notes = deriveWorkflowStepNotes({ rawOutput: "", verdict, notes: parsed.notes });
      if (notes) return notes;
    } catch {
      // Continue to prose recovery.
    }
  }

  let prose = stripStructuredVerdictPayload(rawOutput);
  const noteObjects = extractJsonObjectCandidates(prose).filter((candidate) => {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.hasOwn(parsed, "notes"));
    } catch {
      return false;
    }
  }).sort((left, right) => right.length - left.length);
  for (const candidate of noteObjects) prose = prose.split(candidate).join("");
  return deriveWorkflowStepNotes({ rawOutput: prose, verdict, notes: "" });
}

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
  /** Fixed reason when this successful control-flow outcome performed no check. */
  notRunReason?: WorkflowStepNotRunReason;
  revisionRequested?: boolean;
  output?: string;
  error?: string;
  /** Machine-readable verdict extracted from structured JSON output. */
  verdict?: WorkflowStepVerdict;
  /**
   * FNXC:ReviewVerdictAuthority 2026-09-02-19:25:
   * True when this execution owed a structured JSON verdict. Absence identifies a legacy or
   * non-review outcome and preserves its prior status-only semantics.
   */
  verdictRequired?: boolean;
  /** Notes extracted from structured JSON output (distinct from raw output). */
  notes?: string;
  /**
   * FNXC:ReviewVerdictNotes 2026-08-28-21:23:
   * A verdict-carrying result must carry human-readable reviewer text. This transient flag asks the
   * live-session execution seam for one bounded note repair and is never persisted as task state.
   */
  notesMissing?: boolean;
  /** Normalized independently actionable feedback from a review-kind node. */
  findings?: WorkflowReviewFinding[];
  /** Structured workspace review outcomes for durable node-result persistence. */
  repositoryReviewOutcomes?: WorkflowRepositoryReviewOutcome[];
  /** Confirmed scope generation used for the workspace review. */
  repositoryScopeRevision?: number;
  /** Content-addressed review input used to detect unchanged remediation loops. */
  reviewInputFingerprint?: string;
  /** Commit inspected by this review, used to anchor the next same-gate change summary. */
  reviewedCommitSha?: string;
  /** Specific prior result containing the findings this review step claims are superseded. */
  supersededFindingSourceWorkflowStepId?: string;
  /** Explicit prior-lane finding IDs this review step claims are now superseded. */
  supersededFindingIds?: string[];
  /** Set when the call exceeded `settings.workflowStepTimeoutMs`. Signals the
   *  caller to escalate to the fallback model rather than treat the failure
   *  as a generic revision request. */
  timedOut?: boolean;
  /** True when no authoritative structured verdict or fail-safe prose revision could be inferred. */
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
): { verdict: WorkflowStepVerdict; notes: string; findings?: WorkflowReviewFinding[]; supersededFindingSourceWorkflowStepId?: string; supersededFindingIds?: string[] } | null {
  const trimmed = rawOutput.trim();
  const candidates: string[] = [];
  const fencedMatches = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  for (const match of fencedMatches) {
    candidates.push(match[1].trim());
  }
  /*
  FNXC:ReviewLeniency 2026-07-01-23:30:
  Prefer a balanced, string-aware object scan over a greedy `\{[\s\S]*\}` match: models that emit reasoning PROSE (which may itself contain braces) followed by a trailing `{"verdict":...}` payload broke the greedy span into invalid JSON. extractJsonObjectCandidates returns every balanced object in close order; iterating last→first prefers the trailing verdict payload.
  */
  candidates.push(...extractJsonObjectCandidates(trimmed));

  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(candidates[i]) as { verdict?: unknown; notes?: unknown; findings?: unknown; supersededFindingIds?: unknown; supersededFindingSourceWorkflowStepId?: unknown };
      if (!parsed || typeof parsed.verdict !== "string") continue;
      /*
      FNXC:ReviewVerdictAuthority 2026-09-02-19:49:
      Structured verdict authority is an exact protocol, not a prefix family. Only the declared gate tokens may affect lifecycle state; aliases such as APPROVED, APPROVE_ANYTHING, REQUEST_REVISION, and REJECT remain malformed instead of being normalized into an approval or revision.
      */
      const token = parsed.verdict;
      let verdict: WorkflowStepVerdict | null = null;
      if (token === "APPROVE") {
        verdict = "APPROVE";
      } else if (token === "APPROVE_WITH_NOTES") {
        verdict = "APPROVE_WITH_NOTES";
      } else if (token === "CLOSE_NO_OP" && options.optionalGroupId === PLAN_REVIEW_GROUP_ID) {
        /*
         * FNXC:PlanReviewNoOp 2026-08-09-01:17:
         * Only the built-in Plan Review protocol may request a no-op close. Exact matching
         * prevents prose or unrelated review groups from acquiring a terminal lifecycle path.
         */
        verdict = "CLOSE_NO_OP";
      } else if (token === "REVISE") {
        verdict = "REVISE";
      }
      if (!verdict) continue;
      /*
      FNXC:WorkflowReviewFindings 2026-08-05-06:29:
      Review-kind prompt/script JSON may include a findings array. Normalize through core so invalid
      entries never poison the step outcome or Review-tab selection contract.
      */
      const findings = normalizeWorkflowReviewFindings(parsed.findings);
      const supersededFindingIds = normalizeSupersededFindingIds(parsed.supersededFindingIds);
      const supersededFindingSourceWorkflowStepId = normalizeSupersededFindingIds([parsed.supersededFindingSourceWorkflowStepId])?.[0];
      return {
        verdict,
        notes: typeof parsed.notes === "string" ? parsed.notes : "",
        ...(findings ? { findings } : {}),
        ...(supersededFindingSourceWorkflowStepId && supersededFindingIds ? { supersededFindingSourceWorkflowStepId } : {}),
        ...(supersededFindingSourceWorkflowStepId && supersededFindingIds ? { supersededFindingIds } : {}),
      };
    } catch {
      // continue
    }
  }

  return null;
}

export function inferWorkflowStepVerdictFromProse(
  rawOutput: string,
): { verdict: "REVISE"; notes: string } | null {
  const trimmed = rawOutput.trim();
  const revisionMatch = trimmed.match(/^REQUEST REVISION\s*\n*/i);
  if (revisionMatch) {
    return { verdict: "REVISE", notes: trimmed.slice(revisionMatch[0].length).trim() || "Revision requested" };
  }
  const explicitVerdictMatch = trimmed.match(/(?:^|\n)\s*(?:#{1,6}\s*)?(?:verdict|status)\s*:\s*(APPROVE_WITH_NOTES|APPROVE|REVISE)\b/i);
  if (explicitVerdictMatch?.[1].toUpperCase() === "REVISE") {
    return { verdict: "REVISE", notes: "" };
  }
  return null;
}

/**
 * FNXC:WorkflowGates 2026-09-02-19:16:
 * Gate-class workflow steps must emit a parseable JSON verdict before they can approve pre-merge completion. Prose remains a fail-safe revision request only, while every verdict-less response is surfaced explicitly with a classified protocol failure.
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
  supersededFindingSourceWorkflowStepId?: string;
  supersededFindingIds?: string[];
  malformed?: boolean;
  malformedReason?: WorkflowStepMalformedReason;
  notesMissing?: boolean;
} {
  const trimmed = rawOutput.trim();
  const parsed = parseWorkflowStepVerdict(trimmed, options);
  if (parsed) {
    /*
    FNXC:WorkflowResultText 2026-08-28-13:46:
    Structured verdict output deliberately mirrors parsed notes so downstream task logs and result consumers receive human-readable text instead of raw JSON. This makes output and notes identical by contract; presentation surfaces must collapse that pair rather than changing the persisted producer shape.
    */
    if (parsed.verdict === "CLOSE_NO_OP") {
      return {
        output: parsed.notes || "",
        verdict: parsed.verdict,
        notes: parsed.notes,
        ...(parsed.findings ? { findings: parsed.findings } : {}),
        ...(parsed.supersededFindingSourceWorkflowStepId && parsed.supersededFindingIds ? { supersededFindingSourceWorkflowStepId: parsed.supersededFindingSourceWorkflowStepId, supersededFindingIds: parsed.supersededFindingIds } : {}),
      };
    }
    const notes = deriveWorkflowStepNotes({
      rawOutput: trimmed,
      verdict: parsed.verdict,
      notes: parsed.notes,
      findings: parsed.findings,
    });
    return {
      output: notes ?? "",
      verdict: parsed.verdict,
      notes: notes ?? "",
      ...(!notes ? { notesMissing: true } : {}),
      ...(parsed.findings ? { findings: parsed.findings } : {}),
      ...(parsed.supersededFindingSourceWorkflowStepId && parsed.supersededFindingIds ? { supersededFindingSourceWorkflowStepId: parsed.supersededFindingSourceWorkflowStepId, supersededFindingIds: parsed.supersededFindingIds } : {}),
    };
  }

  const inferred = inferWorkflowStepVerdictFromProse(trimmed);
  if (inferred) {
    const notes = inferred.notes || trimmed;
    return {
      output: notes,
      verdict: inferred.verdict,
      notes,
    };
  }

  if (options.requireVerdict === false) {
    return { output: trimmed };
  }

  const explicitApprovalLine = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:verdict|status)\s*:\s*APPROVE(?:_WITH_NOTES)?\b/i.test(trimmed);
  const malformedReason: WorkflowStepMalformedReason = textHasStructuredVerdictKey(trimmed)
    ? "unreadable-structured-verdict"
    : explicitApprovalLine || proseSignalsClearApproval(trimmed)
      ? "prose-approval-without-json"
      : "no-verdict";
  return { output: trimmed, malformed: true, malformedReason };
}
