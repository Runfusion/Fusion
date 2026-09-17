/*
FNXC:HumanMergeApproval 2026-09-17-18:09:
FN-514 — the CORRECTION PLANNER for an accepted human rejection.

Routing decision recorded in the spec and implemented here (the three options were compared):

  • «always send the card back to Planning» is ILLEGAL and would lose work: lifecycle containment
    forbids review → hold/intake, and a spec re-specification restarts the cycle instead of
    preserving the branch, worktree and finished steps.
  • «always append a small fix» cannot express a wrong approach, a missed requirement, or a rejected
    architectural choice.
  • THIS: one analysis that classifies the refusal as targeted (`fixSteps`) or structural (`replan`).
    `replan` means a CORRECTIVE RE-PLAN IN PLACE — a versioned amendment describing the new approach
    plus replacement steps that execute it — never a move of the card back to Planning and never an
    erasure of the original plan or of the approved-plan evidence.

Boundaries this module keeps:
  • It reads and reasons; it performs NO product write. The host validates the structured output and
    owns publication, so the model can never approve the work, downgrade the refusal to advice, or
    fabricate a Code Review verdict.
  • Model unavailability, a timeout, an abort, or malformed output leave the refusal durably CLOSED
    and retryable in review. None of them authorize a delivery.
  • Every rejection requirement must map to concrete work with verification; a proposal that covers
    nothing is refused by the validator below, not silently accepted.
*/

import {
  formatHumanMergeRejectionSection,
  type HumanMergeRejection,
  type Settings,
  type Task,
  type TaskStore,
} from "@fusion/core";
import {
  createResolvedAgentSession,
  resolveImplicitPlanningFallbackModel,
  resolvePlanningFallbackThinkingLevel,
  resolvePlanningSessionModel,
  resolvePlanningThinkingLevel,
} from "../agents/agent-session-helpers.js";
import { promptWithFallback } from "../pi.js";

export type HumanMergeCorrectionMode = "fixSteps" | "replan";

export interface HumanMergeCorrectionStep {
  /** Operator-facing headline; the body lives in `detail`. */
  title: string;
  detail: string;
  /** Project-relative files this step is expected to change. */
  files: string[];
  /** The check that proves this step actually satisfied the requirement. */
  verification: string;
}

export interface HumanMergeCorrectionPlan {
  mode: HumanMergeCorrectionMode;
  rationale: string;
  /** Which parts of the operator's instruction each step set covers. Must be non-empty. */
  coveredRequirements: string[];
  steps: HumanMergeCorrectionStep[];
  /** Present for `replan`: the versioned amendment describing the replacement approach. */
  amendment?: string;
}

export class HumanMergeCorrectionPlanError extends Error {
  constructor(message: string, readonly code: "invalid-output" | "unavailable" | "empty-work") {
    super(message);
    this.name = "HumanMergeCorrectionPlanError";
  }
}

/*
FNXC:HumanMergeApproval 2026-09-17-18:09:
The analysis prompt. It receives the original request, the current plan, the rejection instruction,
the delivered changes and reports, and the reviews — everything the operator was looking at when they
refused. It deliberately does NOT receive the Code Review severity threshold: a human refusal is not
filtered by the machine reviewer's bar, and being outside the old File Scope is not a reason to
release it.
*/
export function buildHumanMergeCorrectionPrompt(input: {
  task: Pick<Task, "id" | "title" | "description" | "prompt" | "modifiedFiles" | "steps">;
  rejection: HumanMergeRejection;
  reviewSummary?: string;
}): string {
  const steps = (input.task.steps ?? [])
    .map((step, index) => `  ${index}. [${step.status}] ${step.name}`)
    .join("\n");
  return [
    "You are analysing an operator's refusal of finished work so it can be corrected on THIS task.",
    "",
    formatHumanMergeRejectionSection(input.rejection),
    "",
    "## Original Request",
    "",
    input.task.description ?? "",
    "",
    "## Current Plan",
    "",
    input.task.prompt ?? "(no plan recorded)",
    "",
    "## Steps Already Executed",
    "",
    steps || "(none)",
    "",
    "## Files Delivered",
    "",
    (input.task.modifiedFiles ?? []).join("\n") || "(none recorded)",
    ...(input.reviewSummary ? ["", "## Automated Review Outcome", "", input.reviewSummary] : []),
    "",
    "## What To Produce",
    "",
    "Classify the refusal, then produce the work that satisfies it.",
    "",
    "- `fixSteps` — the delivered approach is right and specific defects must be corrected.",
    "- `replan` — a requirement was missed, the journey is wrong, or an architectural choice was",
    "  rejected. Produce an `amendment` describing the replacement approach, plus the ordered steps",
    "  that execute it. This is a corrective re-plan IN PLACE: the branch, the worktree and the",
    "  finished steps are preserved, and the original request stays authoritative.",
    "",
    "A structural correction may span several files or repositories — do not shrink it into a single",
    "cosmetic fix. Every part of the operator's instruction must map to real work and a real check.",
    "You must not approve the delivery, soften the refusal into advice, or emit a review verdict.",
    "",
    "Reply with ONLY a JSON object:",
    "{",
    '  "mode": "fixSteps" | "replan",',
    '  "rationale": string,',
    '  "coveredRequirements": string[],',
    '  "amendment": string,            // required when mode is "replan"',
    '  "steps": [{ "title": string, "detail": string, "files": string[], "verification": string }]',
    "}",
  ].join("\n");
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

/** Extract the JSON object from a model reply that may be fenced or surrounded by prose. */
function extractJsonObject(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced?.[1] ?? raw).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new HumanMergeCorrectionPlanError("no JSON object in reply", "invalid-output");
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    throw new HumanMergeCorrectionPlanError("reply is not valid JSON", "invalid-output");
  }
}

/*
FNXC:HumanMergeApproval 2026-09-17-18:09:
HOST-SIDE validation of the structured output. It is the only thing standing between a model reply
and durable work, so it refuses rather than repairs:

  • an unknown mode, or `replan` with no amendment;
  • no steps at all, or a step with no files or no verification — that would produce a correction
    cycle with nothing to run and nothing to prove;
  • no covered requirement — the refusal would be closed without being answered.

`files` are normalized to project-relative paths; an absolute path or a traversal escape is dropped,
so the correction can widen the declared File Scope through the canonical publication path without
ever widening the agent's filesystem boundary.
*/
export function parseHumanMergeCorrectionPlan(raw: string): HumanMergeCorrectionPlan {
  const parsed = extractJsonObject(raw) as Record<string, unknown>;
  const mode = parsed.mode;
  if (mode !== "fixSteps" && mode !== "replan") {
    throw new HumanMergeCorrectionPlanError("mode must be fixSteps or replan", "invalid-output");
  }
  const rationale = typeof parsed.rationale === "string" ? parsed.rationale.trim() : "";
  if (!rationale) throw new HumanMergeCorrectionPlanError("rationale is required", "invalid-output");

  const coveredRequirements = asStringArray(parsed.coveredRequirements);
  if (coveredRequirements.length === 0) {
    throw new HumanMergeCorrectionPlanError("the plan covers none of the rejection requirements", "invalid-output");
  }

  const amendment = typeof parsed.amendment === "string" ? parsed.amendment.trim() : "";
  if (mode === "replan" && amendment.length === 0) {
    throw new HumanMergeCorrectionPlanError("a structural correction requires an amendment", "invalid-output");
  }

  const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : [];
  const steps: HumanMergeCorrectionStep[] = [];
  for (const entry of rawSteps) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title.trim() : "";
    const detail = typeof record.detail === "string" ? record.detail.trim() : "";
    const verification = typeof record.verification === "string" ? record.verification.trim() : "";
    const files = asStringArray(record.files)
      .map((file) => file.replaceAll("\\", "/").replace(/^\.\//, "").trim())
      .filter((file) => file.length > 0 && !file.startsWith("/") && !file.split("/").includes(".."));
    if (!title || !verification || files.length === 0) continue;
    steps.push({ title, detail: detail || title, files, verification });
  }
  if (steps.length === 0) {
    throw new HumanMergeCorrectionPlanError("the plan produced no runnable corrective work", "empty-work");
  }

  return {
    mode,
    rationale,
    coveredRequirements,
    steps,
    ...(amendment ? { amendment } : {}),
  };
}

/*
Render the versioned amendment appended to PROMPT.md through the canonical publication path. It
describes the replacement approach and the corrective steps WITHOUT rewriting the original request or
the recorded plan history: the initial plan and its approval evidence stay readable, so no approval
is fabricated and none is erased.
*/
export function formatHumanMergeCorrectionAmendment(
  plan: HumanMergeCorrectionPlan,
  rejection: HumanMergeRejection,
): string {
  const lines = [
    "",
    `## Correction Amendment ${rejection.remediationGeneration} — Operator Rejected The Delivery`,
    "",
    `Recorded ${rejection.rejectedAt} by ${rejection.rejectedBy}. The original request and the plan`,
    "above remain authoritative; this amendment records what must change and why.",
    "",
    "### Operator Instructions",
    "",
    rejection.instruction,
    "",
    "### Analysis",
    "",
    plan.rationale,
    "",
    "### Requirements This Correction Must Satisfy",
    "",
    ...plan.coveredRequirements.map((requirement) => `- ${requirement}`),
  ];
  if (plan.mode === "replan" && plan.amendment) {
    lines.push("", "### Replacement Approach", "", plan.amendment);
  }
  lines.push(
    "",
    "### Corrective Steps",
    "",
    ...plan.steps.flatMap((step, index) => [
      `${index + 1}. **${step.title}** — ${step.detail}`,
      `   - Files: ${step.files.join(", ")}`,
      `   - Verification: ${step.verification}`,
    ]),
    "",
  );
  return lines.join("\n");
}

/** Files the correction declares, for widening the task's `## File Scope` at publication time. */
export function collectHumanMergeCorrectionFiles(plan: HumanMergeCorrectionPlan): string[] {
  return [...new Set(plan.steps.flatMap((step) => step.files))].sort();
}

/** Bound on the captured reply: the contract is one JSON object, never a transcript. */
const ANALYSIS_REPLY_MAX_CHARS = 200_000;

export interface HumanMergeCorrectionAnalysisDeps {
  store: Pick<TaskStore, "appendAgentLog">;
  settings: Settings;
  /** Forwarded so CLI-backed runtimes (grok/claude) resolve exactly as they do for every other lane. */
  pluginRunner?: unknown;
  /** Working directory for the READ-ONLY analysis session; the task checkout when it still exists. */
  cwd: string;
  /** Graph cancellation. A cancelled analysis leaves the refusal closed and retryable. */
  signal?: AbortSignal;
  /** Injected only by tests; production resolves the real session. */
  createSession?: typeof createResolvedAgentSession;
}

/*
FNXC:HumanMergeApproval 2026-09-17-22:32:
FN-514 P0 remediation — the PRODUCTION analysis session.

Review found `publishHumanMergeCorrection` had no production caller and no real `analyze`
implementation, so an accepted rejection stayed `pending` forever and closed every door. This is the
missing half: a real planner-lane session resolved through `createResolvedAgentSession`, so it
inherits the project's planning model, its fallback pair, thinking level, credentials, test mode and
runtime routing exactly like triage does.

Deliberate boundaries:
  • `tools: "read"` — the model READS the delivered work and reasons about it. It is never given a
    product write, so it cannot approve the delivery, soften the refusal, or edit the branch.
  • ONE primary attempt plus at most the single sequential fallback swap `promptWithFallback` already
    owns. No bespoke retry ladder.
  • Abort, provider failure and an empty reply all THROW, which the caller converts into a `pending`
    + `lastError` episode: the refusal stays durably closed and explicitly retryable in review.
*/
export async function runHumanMergeCorrectionAnalysis(
  task: Pick<Task, "id" | "title" | "description" | "prompt" | "modifiedFiles" | "steps">
    & Partial<Pick<Task, "planningModelProvider" | "planningModelId" | "planningThinkingLevel" | "thinkingLevel">>,
  rejection: HumanMergeRejection,
  deps: HumanMergeCorrectionAnalysisDeps,
): Promise<string> {
  const settings = (deps.settings ?? {}) as Settings;
  const planningModel = resolvePlanningSessionModel(
    task.planningModelProvider ?? undefined,
    task.planningModelId ?? undefined,
    settings,
  );
  const implicitFallback = resolveImplicitPlanningFallbackModel(
    settings,
    planningModel.provider,
    planningModel.modelId,
  );

  let reply = "";
  const createSession = deps.createSession ?? createResolvedAgentSession;
  const { session } = await createSession({
    sessionPurpose: "triage",
    pluginRunner: deps.pluginRunner,
    cwd: deps.cwd,
    systemPrompt:
      "You analyse an operator's refusal of finished work and produce the corrective plan that answers it. "
      + "You may read the repository to ground your analysis. You must not modify any file, run any command that "
      + "changes state, approve the delivery, or emit a review verdict. Reply with the requested JSON object only.",
    tools: "read",
    onText: (text: string) => {
      reply = `${reply}${text}`.slice(0, ANALYSIS_REPLY_MAX_CHARS);
    },
    defaultProvider: planningModel.provider,
    defaultModelId: planningModel.modelId,
    ...(planningModel.credentialInstanceId ? { credentialInstanceId: planningModel.credentialInstanceId } : {}),
    fallbackProvider: settings.planningFallbackProvider ?? implicitFallback.provider,
    fallbackModelId: settings.planningFallbackModelId ?? implicitFallback.modelId,
    fallbackThinkingLevel: resolvePlanningFallbackThinkingLevel(
      settings,
      task.planningThinkingLevel ?? task.thinkingLevel,
    ),
    defaultThinkingLevel: resolvePlanningThinkingLevel(settings, task.planningThinkingLevel ?? task.thinkingLevel),
    settings,
    taskId: task.id,
    taskTitle: task.title,
  } as never);

  try {
    if (deps.signal?.aborted) {
      throw new HumanMergeCorrectionPlanError("correction analysis was cancelled", "unavailable");
    }
    await Promise.resolve(deps.store.appendAgentLog?.(
      task.id,
      "Analysing the operator's delivery rejection to produce corrective work",
      "status",
    )).catch(() => undefined);
    await promptWithFallback(session, buildHumanMergeCorrectionPrompt({ task, rejection }));
    if (deps.signal?.aborted) {
      /* A late reply from a cancelled analysis must not publish work for a superseded episode. */
      throw new HumanMergeCorrectionPlanError("correction analysis was cancelled", "unavailable");
    }
    if (reply.trim().length === 0) {
      throw new HumanMergeCorrectionPlanError("the correction analysis produced no reply", "unavailable");
    }
    return reply;
  } catch (error) {
    if (error instanceof HumanMergeCorrectionPlanError) throw error;
    throw new HumanMergeCorrectionPlanError(
      error instanceof Error ? error.message : String(error),
      "unavailable",
    );
  } finally {
    try {
      (session as { dispose?: () => unknown }).dispose?.();
    } catch {
      // Disposal failure must not convert a usable analysis into a lost one.
    }
  }
}
