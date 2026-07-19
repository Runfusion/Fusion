import { computeContentFingerprint, findDuplicateMatches, tokenize } from "./duplicate-detection.js";
import type { ColumnId } from "./types.js";
import type { TaskStore } from "./store.js";

export interface SameAgentDuplicateInput {
  title?: string | null;
  description: string;
  /**
   * Parent task that spawned this task (e.g., the executing task whose heartbeat
   * agent called fn_task_create). When set, candidates sharing the same parent
   * are considered siblings even if they have different sourceAgentId values.
   */
  sourceParentTaskId?: string | null;
}

export interface SameAgentDuplicateCandidate {
  id: string;
  title: string;
  description: string;
  column: ColumnId;
  createdAt: number;
  sourceAgentId: string | null;
  sourceParentTaskId?: string | null;
  tombstoned?: boolean;
  deletedAt?: string;
  allowResurrection?: boolean;
}

export interface SameAgentDuplicateMatch {
  id: string;
  score: number;
  tombstoned?: boolean;
  deletedAt?: string;
  allowResurrection?: boolean;
}

const INTENT_BOILERPLATE_TOKENS = new Set([
  "add", "app", "agentic", "as", "bug", "feedback", "filing", "help", "idea", "ideas",
  "optional", "privacy", "report", "reports", "reporting", "pipeline", "existing", "new",
  "selectable", "support", "target", "use",
]);

function intentTokens(title: string | null | undefined, description: string): string[] {
  return tokenize(`${title ?? ""} ${description}`)
    .filter((token) => token.length >= 2 && !INTENT_BOILERPLATE_TOKENS.has(token))
    .map((token) => token.length > 4 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token);
}

function intentBigrams(title: string | null | undefined, description: string): Set<string> {
  const tokens = intentTokens(title, description);
  return new Set(tokens.slice(0, -1).map((token, index) => `${token}:${tokens[index + 1]}`));
}

function hasSingleTokenReplacement(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.filter((token, index) => token !== right[index]).length === 1;
}

function stableIntentAnchor(title: string | null | undefined, description: string): string | null {
  const text = `${title ?? ""} ${description}`;
  const namedAnchors = [
    ...(text.match(/[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+/g) ?? []),
    ...(text.match(/\b[A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+)+\b/g) ?? []),
  ].map((value) => value.toLowerCase().split(/[\s-]+/)
    .filter((token) => token && !INTENT_BOILERPLATE_TOKENS.has(token))
    .map((token) => token.length > 4 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token)
    .join(":"))
    .filter(Boolean)
    .sort();
  return namedAnchors[0] ?? [...intentBigrams(title, description)].sort()[0] ?? null;
}

/** Stable database idempotency claim for one parent-scoped follow-up intent. */
export function computeParentIntentClaimId(input: SameAgentDuplicateInput): string | null {
  const parentId = input.sourceParentTaskId?.trim().toUpperCase();
  const anchor = stableIntentAnchor(input.title, input.description)
    ?? computeContentFingerprint({ title: input.title, description: input.description });
  return parentId && anchor ? `agent-parent-intent:${parentId}:${anchor}` : null;
}

const DIAGNOSTIC_ACTION_PATTERN = /\b(?:fix|investigate|repair|resolve|restore)\b/i;
const DIAGNOSTIC_FAILURE_PATTERN = /\b(?:cannot|can't|error|fail(?:ed|ure|s)?|missing|ts\d{4}|typecheck|unresolved)\b/i;
const DIAGNOSTIC_OBJECT_PATTERNS = [
  /\b(?:missing|unresolved)\s+([`'"]?[@a-z0-9][@a-z0-9._/-]*[`'"]?)/gi,
  /\b(?:cannot|can't)\s+(?:find|resolve)(?:\s+module)?\s+(?:the\s+)?([`'"]?[@a-z0-9][@a-z0-9._/-]*[`'"]?)/gi,
];
const IGNORED_DIAGNOSTIC_OBJECTS = new Set(["a", "an", "dependency", "module", "the", "type", "types"]);

function normalizeDiagnosticObject(value: string): string | null {
  const normalized = value.toLowerCase().replace(/^[`'"]+|[`'".,;:]+$/g, "");
  if (!normalized || IGNORED_DIAGNOSTIC_OBJECTS.has(normalized)) {
    return null;
  }
  // Only code-shaped objects are safe for global convergence. Generic prose
  // such as "missing button" must remain scoped to its parent task.
  return /[0-9@./_-]/.test(normalized) ? normalized : null;
}

/**
 * Stable claim for an active diagnostic follow-up that may be discovered by
 * several unrelated parent tasks. This is intentionally narrower than general
 * near-duplicate matching: only repair-shaped failures with a code identifier
 * can converge globally.
 */
export function computeCrossParentDiagnosticClaim(input: Pick<SameAgentDuplicateInput, "title" | "description">): { id: string; searchTerm: string } | null {
  const text = `${input.title ?? ""}\n${input.description}`;
  if (!DIAGNOSTIC_ACTION_PATTERN.test(text) || !DIAGNOSTIC_FAILURE_PATTERN.test(text)) return null;

  const objects = DIAGNOSTIC_OBJECT_PATTERNS.flatMap((pattern) =>
    [...text.matchAll(pattern)]
      .map((match) => normalizeDiagnosticObject(match[1] ?? ""))
      .filter((value): value is string => value !== null),
  );
  const diagnosticObject = [...new Set(objects)].sort()[0];
  if (!diagnosticObject) return null;
  const fingerprint = computeContentFingerprint({ title: "agent-diagnostic-intent", description: diagnosticObject });
  return fingerprint ? { id: `agent-diagnostic-intent:${fingerprint}`, searchTerm: diagnosticObject } : null;
}

export function computeCrossParentDiagnosticClaimId(input: Pick<SameAgentDuplicateInput, "title" | "description">): string | null {
  return computeCrossParentDiagnosticClaim(input)?.id ?? null;
}

/**
 * Find candidate tasks that look like duplicates spawned by the same caller.
 *
 * "Same caller" means the candidate shares the input's `sourceAgentId` (legacy
 * FN-5233 behavior) OR shares the input's `sourceParentTaskId` when set
 * (provenance dedup — same parent task spawned similar siblings).
 *
 * Filters out candidates older than `windowMs` (default 24h) and candidates
 * with neither a matching sourceAgentId nor a matching sourceParentTaskId.
 */
export function findSameAgentDuplicates(
  input: SameAgentDuplicateInput,
  candidates: SameAgentDuplicateCandidate[],
  opts?: { threshold?: number; nowMs?: number; windowMs?: number; sourceAgentId?: string | null },
): SameAgentDuplicateMatch[] {
  const threshold = opts?.threshold ?? 0.75;
  const nowMs = opts?.nowMs ?? Date.now();
  const windowMs = opts?.windowMs ?? 24 * 60 * 60 * 1000;
  const cutoff = nowMs - windowMs;
  const inputAgentId = opts?.sourceAgentId ?? null;
  const inputParentId = input.sourceParentTaskId ?? null;

  const recent = candidates.filter((candidate) => {
    const agentMatch = inputAgentId != null && candidate.sourceAgentId === inputAgentId;
    const parentMatch = inputParentId != null && candidate.sourceParentTaskId === inputParentId;
    if (!agentMatch && !parentMatch) return false;
    if (candidate.tombstoned) return true;
    return candidate.createdAt >= cutoff;
  });

  const matches = findDuplicateMatches(
    { title: input.title ?? undefined, description: input.description },
    recent.map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      description: candidate.description,
      column: candidate.column,
    })),
    { threshold },
  );

  const metadataById = new Map(recent.map((candidate) => [candidate.id, candidate]));
  const mappedMatches = matches.map((match) => {
    const candidate = metadataById.get(match.id);
    return {
      id: match.id,
      score: match.score,
      tombstoned: candidate?.tombstoned,
      deletedAt: candidate?.deletedAt,
      allowResurrection: candidate?.allowResurrection,
    };
  });
  if (mappedMatches.length > 0 || !inputParentId) return mappedMatches;

  /*
  FNXC:TaskCreationDeduplication 2026-07-18-12:36:
  Exact content fingerprints cannot contain a retried agent step that paraphrases
  its follow-up. Within one parent and the existing 24-hour window, reuse a live
  sibling only when a meaningful adjacent intent phrase survives the rewrite.
  Bigrams keep distinct actions such as "screenshot upload" and "screenshot delete"
  separate while recognizing stable concepts such as "GitHub Discussions".
  */
  const sourceTokens = intentTokens(input.title, input.description);
  const sourceBigrams = intentBigrams(input.title, input.description);
  const sourceAnchor = stableIntentAnchor(input.title, input.description);
  if (sourceBigrams.size === 0) return [];
  return recent.flatMap((candidate) => {
    if (candidate.tombstoned || candidate.column === "done" || candidate.column === "archived") return [];
    const candidateTokens = intentTokens(candidate.title, candidate.description);
    if (sourceAnchor !== stableIntentAnchor(candidate.title, candidate.description)
      || hasSingleTokenReplacement(sourceTokens, candidateTokens)) return [];
    const candidateBigrams = intentBigrams(candidate.title, candidate.description);
    const sharedCount = [...sourceBigrams].filter((bigram) => candidateBigrams.has(bigram)).length;
    const identicalIntent = sourceTokens.join(":") === candidateTokens.join(":");
    const diceScore = (2 * sharedCount) / (sourceBigrams.size + candidateBigrams.size);
    return identicalIntent || (sharedCount >= 2 && diceScore >= 0.3)
      ? [{ id: candidate.id, score: diceScore }]
      : [];
  }).sort((left, right) =>
    (metadataById.get(left.id)?.createdAt ?? Number.POSITIVE_INFINITY)
    - (metadataById.get(right.id)?.createdAt ?? Number.POSITIVE_INFINITY),
  );
}

export async function archiveAsSameAgentDuplicate(
  store: TaskStore,
  taskId: string,
  siblingIds: string[],
  scores: Record<string, number>,
): Promise<void> {
  await store.logEntry(
    taskId,
    "Auto-archived as same-agent duplicate",
    `Duplicate of recently-filed sibling task(s): ${siblingIds.join(", ")}`,
  );
  // FN-4892: store-side intake path does activity-only emission; run-audit requires runId+agentId context from engine callers.
  await store.recordActivity({
    type: "task:auto-archived-duplicate",
    taskId,
    details: "Auto-archived as same-agent duplicate during intake",
    metadata: { siblingTaskIds: siblingIds, scores },
  });
  await store.moveTask(taskId, "archived");
}

/**
 * FNXC:DuplicateIntake 2026-07-07-00:00 (FN-7658):
 * This is the DEFAULT same-agent duplicate intake outcome (the setting
 * `autoArchiveDuplicateTasksEnabled` defaults to `false`). Operators do not
 * want duplicates silently disappearing into `archived` on creation — they
 * want visibility and a chance to decide. Instead of moving the task, this
 * records the same near-duplicate marker (`nearDuplicateOf`/`nearDuplicateScore`)
 * used elsewhere (see FN-6439 `clearNearDuplicateReferencesTo`) so the dashboard's
 * existing yellow "Duplicate" chip with Keep/Archive actions to surface it
 * for a human decision. The task is left in whatever column it was created
 * in — this function does NOT call `moveTask`.
 *
 * `siblingIds` should be ordered with the canonical/earliest sibling first;
 * that first id becomes `nearDuplicateOf` and its score becomes
 * `nearDuplicateScore`.
 */
export async function flagSameAgentDuplicate(
  store: TaskStore,
  taskId: string,
  siblingIds: string[],
  scores: Record<string, number>,
): Promise<Record<string, unknown> | undefined> {
  const canonicalId = siblingIds[0];
  await store.logEntry(
    taskId,
    "Flagged as same-agent duplicate",
    `Near-duplicate of recently-filed sibling task(s): ${siblingIds.join(", ")} (not archived — autoArchiveDuplicateTasksEnabled is off)`,
  );
  // FN-7658: reuse the existing duplicate activity type with a `source` disambiguator
  // rather than inventing a schema-unknown activity type; run-audit consumers already
  // understand `task:auto-archived-duplicate` and can key off `metadata.source`.
  await store.recordActivity({
    type: "task:auto-archived-duplicate",
    taskId,
    details: "Flagged (not archived) as same-agent duplicate during intake",
    metadata: { siblingTaskIds: siblingIds, scores, source: "same-agent-flagged" },
  });
  if (!canonicalId) return undefined;
  const sourceMetadataPatch = {
    nearDuplicateOf: canonicalId,
    nearDuplicateScore: scores[canonicalId] ?? null,
  };
  await store.updateTask(taskId, { sourceMetadataPatch });
  // Return the applied patch so the in-memory task object held by the createTask
  // caller (which was written to disk BEFORE this flag runs) can be kept in sync
  // without a redundant re-fetch.
  return sourceMetadataPatch;
}


/**
 * FNXC:DuplicateIntake 2026-07-16-13:00:
 * Issue #2225 keeps triage-marker duplicates visible for an operator decision. Reuse the
 * near-duplicate metadata consumed by the existing linked banner/chip; never move or delete here.
 * Reset a prior Keep acknowledgement so a later marker cannot leave the task blocked without its UI.
 */
export async function flagTriageDuplicate(
  store: TaskStore,
  taskId: string,
  canonicalId: string,
): Promise<Record<string, unknown>> {
  const sourceMetadataPatch = {
    nearDuplicateOf: canonicalId,
    nearDuplicateScore: 1,
    duplicateSource: "triage-marker",
    nearDuplicateDismissed: false,
  };
  await store.logEntry(taskId, "Flagged as triage duplicate", `Duplicate marker points to ${canonicalId}; awaiting operator decision`);
  await store.recordActivity({
    type: "task:auto-archived-duplicate",
    taskId,
    details: "Flagged (not deleted) as triage-marker duplicate",
    metadata: { canonicalTaskId: canonicalId, source: "triage-marker-flagged" },
  });
  await store.updateTask(taskId, { sourceMetadataPatch });
  return sourceMetadataPatch;
}
