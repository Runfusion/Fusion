/**
 * FNXC:ReviewLaneRecommendations 2026-08-26-07:34:
 * Extract follow-up proposals from a review-lane node's OUTPUT.
 *
 * Why output and not a tool call: a workflow-step node running `toolMode: "readonly"` is limited to
 * `read/grep/find/ls` plus a few read-only task reads (`workflow-step-tool-policy.ts`). It holds no
 * writer at all, and `fn_task_create` is explicitly DENIED there — which is correct, because an
 * in-review agent must never create board rows. Projection is therefore the only durable channel it
 * has, exactly as it already is for the completion summary.
 *
 * Measured before this existed: the Documentation milestone's prompt asked it to call
 * `fn_task_done`, `fn_task_document_write`, `fn_artifact_register` and `fn_task_create`. It could
 * call none of them. It produced a well-formed report every run and persisted nothing — the same
 * failure mode as instructing a readonly reviewer to run tests, and just as invisible.
 *
 * The payload is deliberately separate from the verdict JSON: a reporting node requires no verdict
 * (`summaryTarget` suppresses that requirement), so a parser keyed on `verdict` would never see it.
 */
import { normalizeTaskRecommendations, type Settings, type TaskRecommendation } from "@fusion/core";

import { extractJsonObjectCandidates } from "../execution/reviewer.js";

/** Default mirrors `settings-schema.ts`; 0 disables capture entirely. */
const DEFAULT_MAX_RECOMMENDATIONS = 3;

export function resolveMaxRecommendationsPerTask(settings: Settings | undefined): number {
  const configured = (settings as { maxRecommendationsPerTask?: unknown } | undefined)?.maxRecommendationsPerTask;
  return typeof configured === "number" && Number.isInteger(configured) && configured >= 0
    ? configured
    : DEFAULT_MAX_RECOMMENDATIONS;
}

export interface ParsedWorkflowStepRecommendations {
  recommendations: TaskRecommendation[];
  /** The output with the consumed payload removed, so a summary projection never shows raw JSON. */
  remainingText: string;
}

export function parseWorkflowStepRecommendations(
  rawOutput: string,
  options: { max: number },
): ParsedWorkflowStepRecommendations {
  if (options.max <= 0) return { recommendations: [], remainingText: rawOutput };

  /*
   * Fenced blocks are scanned first and their FENCE is what gets stripped: models overwhelmingly emit
   * ```json … ```, and removing only the inner object would leave an empty fence in the card summary.
   */
  const fenced = [...rawOutput.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  for (let i = fenced.length - 1; i >= 0; i -= 1) {
    const parsed = readRecommendations(fenced[i][1], options.max);
    if (parsed) {
      return { recommendations: parsed, remainingText: removeSpan(rawOutput, fenced[i][0]) };
    }
  }

  const candidates = extractJsonObjectCandidates(rawOutput);
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const parsed = readRecommendations(candidates[i], options.max);
    if (parsed) {
      return { recommendations: parsed, remainingText: removeSpan(rawOutput, candidates[i]) };
    }
  }

  return { recommendations: [], remainingText: rawOutput };
}

/*
 * A payload is only claimed when the object actually carries a `recommendations` ARRAY. An object
 * without one is someone else's payload (a verdict, a findings block) and must be left intact.
 */
function readRecommendations(candidate: string, max: number): TaskRecommendation[] | undefined {
  try {
    const parsed = JSON.parse(candidate) as { recommendations?: unknown };
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.recommendations)) return undefined;
    return normalizeTaskRecommendations(parsed.recommendations, { max });
  } catch {
    return undefined;
  }
}

function removeSpan(text: string, span: string): string {
  const index = text.lastIndexOf(span);
  if (index < 0) return text;
  return `${text.slice(0, index)}${text.slice(index + span.length)}`.replace(/\n{3,}/g, "\n\n").trim();
}
