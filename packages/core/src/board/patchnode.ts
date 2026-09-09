import type { Task } from "../types/task/task-core.js";
import type { PatchnodeDay, PatchnodeEntry, PatchnodeEntryKind } from "../types/task/patchnode.js";

/*
FNXC:PatchnodeLedger 2026-08-28-12:16:
Patchnode is durable rather than derived because task history can be edited or soft-deleted after delivery. UTC day grouping matches DailyActivity so storage, API, chat, and dashboard assign every delivery to the same date.

FNXC:PatchnodeLedger 2026-08-28-12:16:
Title and body are denormalized point-in-time snapshots because later task updates can rewrite delivery evidence. Identity includes the delivery occurrence rather than only the task, so every re-delivery remains visible. All capture paths must use this one builder or retries and backlog repair can multiply one delivery into different rows.
*/

export function toPatchnodeDay(iso: string): string {
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : iso.trim().slice(0, 10);
}

export function toPatchnodeOccurrenceKey(iso: string): string {
  const normalized = iso.trim();
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? String(timestamp) : normalized;
}

export function buildPatchnodeEntryId(kind: PatchnodeEntryKind, taskId: string, occurrenceKey: string): string {
  return `${kind}:${taskId}:${occurrenceKey}`;
}

type PatchnodeTaskSnapshot = Pick<Task, "id" | "title" | "summary">;

export function buildPatchnodeEntryInput(
  task: PatchnodeTaskSnapshot,
  kind: PatchnodeEntryKind,
  occurredAt: string,
): PatchnodeEntry {
  const taskId = task.id.trim();
  const title = task.title?.trim() || taskId;
  const body = task.summary?.trim() || title || taskId;
  const occurrenceKey = toPatchnodeOccurrenceKey(occurredAt);
  return {
    entryId: buildPatchnodeEntryId(kind, taskId, occurrenceKey),
    taskId,
    kind,
    occurrenceKey,
    day: toPatchnodeDay(occurredAt),
    occurredAt,
    title,
    body,
  };
}

export function groupPatchnodeEntriesByDay(entries: readonly PatchnodeEntry[]): PatchnodeDay[] {
  const sorted = [...entries].sort((left, right) => {
    const byTime = Date.parse(right.occurredAt) - Date.parse(left.occurredAt);
    return Number.isNaN(byTime) || byTime === 0 ? right.entryId.localeCompare(left.entryId) : byTime;
  });
  const grouped = new Map<string, PatchnodeEntry[]>();
  for (const entry of sorted) {
    const dayEntries = grouped.get(entry.day) ?? [];
    dayEntries.push(entry);
    grouped.set(entry.day, dayEntries);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([day, dayEntries]) => ({
      day,
      entries: dayEntries,
      completedCount: dayEntries.filter((entry) => entry.kind === "completed").length,
      revertedCount: dayEntries.filter((entry) => entry.kind === "reverted").length,
    }));
}

export function matchesPatchnodeQuery(entry: PatchnodeEntry, query: string | undefined): boolean {
  const needle = query?.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [entry.taskId, entry.title, entry.body].some((value) => value.toLocaleLowerCase().includes(needle));
}
