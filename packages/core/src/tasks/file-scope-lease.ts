import type { Task } from "../types.js";
import { compareTasksByPriorityThenAgeAndId } from "./task-priority.js";

export type FileScopeLeaseKind = "none" | "active" | "dormant";

export interface FileScopeLeaseClassification {
  kind: FileScopeLeaseKind;
  waivedForTaskIds: readonly string[];
}

/*
FNXC:OverlapScheduling 2026-08-29-05:47:
A file-scope claim lasts until the blocking task's work has landed rather than only while it occupies a
particular board column. Active claims always serialize overlapping work; dormant claims use priority,
age, then task id so two waiting holders choose one deterministic winner instead of freezing each other.
*/
export function fileScopeLeaseBlocksCandidate(
  blocker: Pick<Task, "id" | "priority" | "createdAt">,
  candidate: Pick<Task, "id" | "priority" | "createdAt">,
  classification: FileScopeLeaseClassification,
): boolean {
  if (blocker.id === candidate.id) return false;
  if (classification.waivedForTaskIds.includes(candidate.id)) return false;
  if (classification.kind === "active") return true;
  if (classification.kind === "dormant") {
    return compareTasksByPriorityThenAgeAndId(blocker, candidate) < 0;
  }
  return false;
}
