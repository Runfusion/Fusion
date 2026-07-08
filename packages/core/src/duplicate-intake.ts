import { findDuplicateMatches } from "./duplicate-detection.js";
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
  return matches.map((match) => {
    const candidate = metadataById.get(match.id);
    return {
      id: match.id,
      score: match.score,
      tombstoned: candidate?.tombstoned,
      deletedAt: candidate?.deletedAt,
      allowResurrection: candidate?.allowResurrection,
    };
  });
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
