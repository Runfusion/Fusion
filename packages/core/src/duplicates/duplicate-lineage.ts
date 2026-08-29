import type { SourceType } from "../types.js";
import { DUPLICATE_OF_METADATA_KEY } from "../types.js";

const DUPLICATE_REFERENCE_PATTERN = /\b(?:duplicate(?:s|d)?\s+of|dup(?:e|licate)?\s+of|duplicates)\b\s*[:-]?\s*([A-Z]+-\d+(?:\s*[/,]\s*[A-Z]+-\d+)*)/gi;
const PAREN_DUPLICATE_PATTERN = /\([Dd]uplicate\s+of\s+([A-Z]+-\d+(?:[/,\s]+[A-Z]+-\d+)*)\)/g;
const TASK_ID_PATTERN = /\b[A-Z]+-\d+\b/g;

export function extractDuplicateOfReferences(text: string | null | undefined): string[] {
  if (!text?.trim()) {
    return [];
  }

  const normalized = text.toUpperCase();
  const seen = new Set<string>();
  const collected: string[] = [];

  const collect = (value: string): void => {
    for (const match of value.match(TASK_ID_PATTERN) ?? []) {
      if (seen.has(match)) continue;
      seen.add(match);
      collected.push(match);
    }
  };

  for (const pattern of [DUPLICATE_REFERENCE_PATTERN, PAREN_DUPLICATE_PATTERN]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null = null;
    while ((match = pattern.exec(normalized)) !== null) {
      collect(match[1] ?? "");
    }
  }

  return collected;
}

export interface TaskDuplicateLineageInput {
  id: string;
  title?: string | null;
  description?: string | null;
  sourceType?: SourceType | null;
  sourceParentTaskId?: string | null;
  sourceMetadata?: Record<string, unknown> | null;
  promptText?: string | null;
}

export function getTaskDuplicateLineage(
  task: TaskDuplicateLineageInput,
  opts?: { limit?: number },
): string[] {
  const limit = Math.max(1, opts?.limit ?? 10);
  const selfId = task.id.toUpperCase();
  const seen = new Set<string>();
  const lineage: string[] = [];

  const push = (id: string): void => {
    const normalizedId = id.toUpperCase();
    if (normalizedId === selfId || seen.has(normalizedId)) {
      return;
    }
    seen.add(normalizedId);
    lineage.push(normalizedId);
  };

  if (task.sourceType === "task_duplicate" && task.sourceParentTaskId?.trim()) {
    push(task.sourceParentTaskId.trim());
  }

  const metadataLineage = task.sourceMetadata?.[DUPLICATE_OF_METADATA_KEY];
  if (Array.isArray(metadataLineage)) {
    for (const id of metadataLineage) {
      if (typeof id === "string" && id.trim()) {
        push(id.trim());
      }
    }
  }

  for (const id of extractDuplicateOfReferences(task.title)) push(id);
  for (const id of extractDuplicateOfReferences(task.description)) push(id);
  for (const id of extractDuplicateOfReferences(task.promptText ?? "")) push(id);

  return lineage.slice(0, limit);
}
