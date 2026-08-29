import type { GoalCitationMatch, RunAuditEvent } from "../types.js";

export const GOAL_ID_PATTERN = /\bG-[0-9A-Z]+(?:-[0-9A-Z]+)*\b/g;

export const GOAL_CITATION_SNIPPET_MAX = 200;

export function extractGoalCitations(text: string): GoalCitationMatch[] {
  const normalized = String(text ?? "");
  if (normalized.length === 0) {
    return [];
  }

  const matches: GoalCitationMatch[] = [];
  const seen = new Set<string>();
  const pattern = new RegExp(GOAL_ID_PATTERN.source, GOAL_ID_PATTERN.flags);

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(normalized)) !== null) {
    const goalId = match[0];
    if (seen.has(goalId)) {
      continue;
    }
    seen.add(goalId);
    matches.push({ goalId, index: match.index });
  }

  return matches;
}

const INJECTION_AUDIT_TYPES = new Set(["goal:injection-applied", "goal:injection-skipped", "prompt:goal-injection"]);
const RETRIEVAL_AUDIT_TYPE = "goal:retrieval-invoked";
const GOAL_ID_EXACT_PATTERN = new RegExp(`^${GOAL_ID_PATTERN.source.replace(/\\b/g, "")}$`);

function isGoalId(value: string): boolean {
  return GOAL_ID_EXACT_PATTERN.test(value);
}

function collectGoalIds(ids: Set<string>, values: unknown): void {
  if (!Array.isArray(values)) return;
  for (const value of values) {
    if (typeof value !== "string") continue;
    if (!isGoalId(value)) continue;
    ids.add(value);
  }
}

function collectGoalId(ids: Set<string>, value: unknown): void {
  if (typeof value !== "string") return;
  if (!isGoalId(value)) return;
  ids.add(value);
}

export function collectCitedGoalIdsFromAudit(events: RunAuditEvent[]): {
  injectedGoalIds: string[];
  retrievedGoalIds: string[];
  citedGoalIds: string[];
} {
  const injectedGoalIds = new Set<string>();
  const retrievedGoalIds = new Set<string>();

  for (const event of events) {
    const metadata = event.metadata ?? {};
    if (INJECTION_AUDIT_TYPES.has(event.mutationType)) {
      collectGoalIds(injectedGoalIds, metadata.goalIds);
      continue;
    }

    if (event.mutationType === RETRIEVAL_AUDIT_TYPE) {
      collectGoalIds(retrievedGoalIds, metadata.goalIds);
      collectGoalId(retrievedGoalIds, event.target);
      collectGoalId(retrievedGoalIds, metadata.goalId);
    }
  }

  return {
    injectedGoalIds: [...injectedGoalIds],
    retrievedGoalIds: [...retrievedGoalIds],
    citedGoalIds: [...new Set([...injectedGoalIds, ...retrievedGoalIds])],
  };
}

export function buildSnippet(text: string, index: number, max = GOAL_CITATION_SNIPPET_MAX): string {
  const normalized = String(text ?? "");
  if (normalized.length === 0 || max <= 0) {
    return "";
  }

  const goalMatch = normalized
    .slice(Math.max(0, index))
    .match(/^G-[0-9A-Z]+(?:-[0-9A-Z]+)*/);
  const goalEnd = goalMatch ? index + goalMatch[0].length : index;

  let start = Math.max(0, index - Math.floor(max / 2));
  let end = Math.min(normalized.length, start + max);
  if (end < goalEnd) {
    end = Math.min(normalized.length, goalEnd);
    start = Math.max(0, end - max);
  } else {
    start = Math.max(0, end - max);
  }

  const snippet = normalized
    .slice(start, end)
    .replace(/\s+/g, " ")
    .trim();

  return snippet.length <= max ? snippet : snippet.slice(0, max).trim();
}
