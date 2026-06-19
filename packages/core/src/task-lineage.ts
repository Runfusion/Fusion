import { randomUUID } from "node:crypto";
import type {
  TaskCommitAssociation,
  TaskCommitAssociationConfidence,
  TaskCommitAssociationMatchSource,
} from "./types.js";

export const FUSION_TASK_LINEAGE_TRAILER_KEY = "Fusion-Task-Lineage";

export function generateTaskLineageId(): string {
  return randomUUID();
}

export function buildTaskLineageTrailer(lineageId: string): string {
  return `${FUSION_TASK_LINEAGE_TRAILER_KEY}: ${lineageId}`;
}

export function parseTaskLineageTrailer(message: string): string | undefined {
  const lines = message.split(/\r?\n/);
  const prefix = `${FUSION_TASK_LINEAGE_TRAILER_KEY}:`;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (line?.startsWith(prefix)) {
      const value = line.slice(prefix.length).trim();
      if (value) return value;
    }
  }
  return undefined;
}

export function classifyTaskCommitAssociationConfidence(
  matchedBy: TaskCommitAssociationMatchSource,
): TaskCommitAssociationConfidence {
  if (matchedBy === "canonical-lineage-trailer") return "canonical";
  if (matchedBy === "manual-reconciliation") return "ambiguous";
  return "legacy";
}

export function normalizeTaskCommitAssociation(
  row: TaskCommitAssociation,
): TaskCommitAssociation {
  return {
    ...row,
    note: row.note?.trim() || undefined,
    additions: row.additions ?? undefined,
    deletions: row.deletions ?? undefined,
    confidence: row.confidence ?? classifyTaskCommitAssociationConfidence(row.matchedBy),
  };
}
