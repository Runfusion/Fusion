import { findDuplicateMatches } from "./duplicate-detection.js";
import type { Column } from "./types.js";
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
  column: Column;
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
