/**
 * The renderable set of `CeFlow` (R8/AE1 boundary).
 *
 * `CeFlow` renders four interaction types richly: `text` (free-text input),
 * `single_select`, `multi_select`, and `confirm`. Any other interaction — an
 * unknown future question type, or a select-type question that arrives without
 * the options it needs to render choices — is NOT expressible by the rich
 * renderer and must degrade to the visibly-marked chat fallback.
 *
 * This module is the single source of truth for that boundary so the renderer
 * and the skill-interaction audit agree on what "renderable richly" means.
 */
import type { PlanningQuestion, PlanningQuestionType } from "@fusion/core";

/** The interaction types CeFlow renders with dedicated rich controls. */
export const RICH_INTERACTION_TYPES: readonly PlanningQuestionType[] = [
  "text",
  "single_select",
  "multi_select",
  "confirm",
] as const;

export function isRichInteractionType(type: string): type is PlanningQuestionType {
  return (RICH_INTERACTION_TYPES as readonly string[]).includes(type);
}

/**
 * Whether CeFlow can render this concrete question with rich controls. A
 * select-type question with no usable options can't present choices, so it
 * degrades to chat even though its `type` is in the rich set.
 */
export function canRenderRichly(question: Pick<PlanningQuestion, "type" | "options">): boolean {
  if (!isRichInteractionType(question.type)) return false;
  if (question.type === "single_select" || question.type === "multi_select") {
    return Array.isArray(question.options) && question.options.length > 0;
  }
  return true;
}
