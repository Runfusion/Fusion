/**
 * FNXC:CodeOrganization 2026-08-09-22:10:
 * validateCompletionRecommendations peeled from main executor (FN-8850 / U4).
 *
 * FNXC:TaskRecommendations 2026-08-08-05:02:
 * `fn_task_done` accepts only task-ready, out-of-scope suggestions. Refuse
 * executable or credential-like material so the durable operator surface cannot
 * become a second channel for agent reasoning, commands, or secrets.
 */
import type { TaskRecommendation } from "@fusion/core";

/* FNXC:TaskRecommendations 2026-08-08-07:26: Treat credential-like values, not ordinary security work such as a password-reset feature, as secrets. */
const UNSAFE_RECOMMENDATION_CONTENT = /(?:```|\b(?:api[_-]?key|password|secret|token)\b\s*(?:=|:)\s*\S+|(?:^|\n)\s*(?:[$#]\s*)?(?:npm|pnpm|yarn|bun|npx|node|deno|python(?:3)?|bash|sh|zsh|fish|cmd(?:\.exe)?|powershell|curl|wget|git|docker|kubectl|make|just|rm|cp|mv|chmod|sudo)\b|(?:^|\n)\s*(?:run|execute)\s+(?:(?:npm|pnpm|yarn|bun|npx|node|deno|python(?:3)?|bash|sh|zsh|fish|cmd(?:\.exe)?|powershell|curl|wget|git|docker|kubectl|make|just|rm|cp|mv|chmod|sudo)\b|(?:\.?\.?[\\/]|~[\\/])\S*|\S+\s+(?:-{1,2}\S*|\S*[\\/]\S*|\S+\.(?:sh|py|js|ts|mjs|cjs|exe|bat|cmd)\b))|`(?:npm|pnpm|yarn|bun|npx|node|deno|python(?:3)?|bash|sh|zsh|fish|cmd|powershell|curl|wget|git|docker|kubectl|make|just|rm|cp|mv|chmod|sudo)\b)/im;

/**
 * FNXC:TaskRecommendations 2026-08-08-05:02:
 * Validate and accept only the closed recommendation shape at completion.
 */
export function validateCompletionRecommendations(value: unknown, maximum: number): TaskRecommendation[] | string {
  if (!Array.isArray(value)) return "recommendations must be an array";
  if (value.length > maximum) return `recommendations exceed the project maximum of ${maximum}`;
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") return "each recommendation must be an object";
    const recommendation = item as TaskRecommendation;
    /*
    FNXC:TaskRecommendations 2026-08-08-05:56:
    Completion recommendations are a compact, task-ready handoff rather than an executor transcript.
    Keep the accepted shape closed so agents cannot persist reasoning, tool output, or a pre-linked
    child id alongside an otherwise valid suggestion.
    */
    if (Object.keys(recommendation).some((key) => !["id", "title", "description", "category"].includes(key))) {
      return "each recommendation may contain only id, title, description, and category";
    }
    if (
      typeof recommendation.id !== "string"
      || typeof recommendation.title !== "string"
      || typeof recommendation.description !== "string"
      || !recommendation.id.trim()
      || !recommendation.title.trim()
      || !recommendation.description.trim()
    ) {
      return "each recommendation requires id, title, and description";
    }
    if (!["improvement", "feature", "bug", "other"].includes(recommendation.category)) {
      return "each recommendation category must be improvement, feature, bug, or other";
    }
    if (ids.has(recommendation.id)) return "recommendation ids must be unique";
    if (UNSAFE_RECOMMENDATION_CONTENT.test(`${recommendation.title}\n${recommendation.description}`)) {
      return "recommendations must not contain secrets or executable commands";
    }
    ids.add(recommendation.id);
  }
  return value as TaskRecommendation[];
}
