import type { TaskRecommendation } from "../types/task/task-core.js";

/*
FNXC:TaskRecommendations 2026-08-08-07:15 (relocated 2026-08-26-07:34):
Recommendations are task-ready prose, not a shell execution channel. Reject direct shell/interpreter
syntax and imperative command forms with flags, paths, or script extensions at persistence, where
future writers cannot evade the executor's user-facing validation.

FNXC:TaskRecommendations 2026-08-08-07:26:
Treat credential-like values, not ordinary security work such as a password-reset feature, as secrets.

FNXC:TaskRecommendations 2026-08-26-07:34:
Moved out of the store mutation module so a SECOND producer — a review-lane workflow node projecting
its output — is screened by the same rule rather than a copy of it. A duplicated security regex is a
regex that drifts.
*/
export const UNSAFE_RECOMMENDATION_CONTENT = /(?:```|\b(?:api[_-]?key|password|secret|token)\b\s*(?:=|:)\s*\S+|(?:^|\n)\s*(?:[$#]\s*)?(?:npm|pnpm|yarn|bun|npx|node|deno|python(?:3)?|bash|sh|zsh|fish|cmd(?:\.exe)?|powershell|curl|wget|git|docker|kubectl|make|just|rm|cp|mv|chmod|sudo)\b|(?:^|\n)\s*(?:run|execute)\s+(?:(?:npm|pnpm|yarn|bun|npx|node|deno|python(?:3)?|bash|sh|zsh|fish|cmd(?:\.exe)?|powershell|curl|wget|git|docker|kubectl|make|just|rm|cp|mv|chmod|sudo)\b|(?:\.?\.?[\\/]|~[\\/])\S*|\S+\s+(?:-{1,2}\S*|\S*[\\/]\S*|\S+\.(?:sh|py|js|ts|mjs|cjs|exe|bat|cmd)\b))|`(?:npm|pnpm|yarn|bun|npx|node|deno|python(?:3)?|bash|sh|zsh|fish|cmd|powershell|curl|wget|git|docker|kubectl|make|just|rm|cp|mv|chmod|sudo)\b)/im;

export const RECOMMENDATION_KEYS = new Set(["id", "title", "description", "category", "createdTaskId"]);

const CATEGORIES = new Set(["improvement", "feature", "bug", "other"]);

/*
FNXC:TaskRecommendations 2026-08-26-07:34:
NORMALIZE, never throw. The authoritative store writer asserts and rejects, because a caller that
hands it malformed data has a bug. A model's free-text output is different: one bad entry must drop
out silently rather than fail the node, or a stray character in a proposal would wedge a card whose
code is already approved. Every surviving entry still passes the SAME content rules as the store
boundary, which re-validates on write.
*/
export function normalizeTaskRecommendations(value: unknown, options: { max: number }): TaskRecommendation[] {
  if (!Array.isArray(value) || options.max <= 0) return [];
  const seen = new Set<string>();
  const normalized: TaskRecommendation[] = [];

  for (const entry of value) {
    if (normalized.length >= options.max) break;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const candidate = entry as Record<string, unknown>;
    if (Object.keys(candidate).some((key) => !RECOMMENDATION_KEYS.has(key))) continue;

    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
    const description = typeof candidate.description === "string" ? candidate.description.trim() : "";
    const category = typeof candidate.category === "string" ? candidate.category.trim() : "";
    if (!id || !title || !description || !CATEGORIES.has(category)) continue;
    if (seen.has(id)) continue;
    if (UNSAFE_RECOMMENDATION_CONTENT.test(`${title}\n${description}`)) continue;

    seen.add(id);
    normalized.push({ id, title, description, category: category as TaskRecommendation["category"] });
  }

  return normalized;
}
