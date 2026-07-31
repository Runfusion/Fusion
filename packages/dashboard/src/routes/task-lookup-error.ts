/**
 * FNXC:TaskLookup404 2026-07-26-11:35:
 * Requirement: a task read for a task that does not exist must surface as HTTP
 * 404 across EVERY per-task route, never 500 — clients (task detail view, the
 * PR/review/diff panels, CLI callers) must be able to tell "this task is gone"
 * apart from "the server is broken", and only the latter is worth retrying or
 * paging on.
 *
 * Why this module exists: route catches used to detect a missing task solely by
 * `(err as NodeJS.ErrnoException).code === "ENOENT"`. That was a leftover from
 * the file-backed storage era. In Postgres/backend mode nothing on the task read
 * path sets an errno code, so every missing / unknown / soft-deleted /
 * wrong-project task read fell through to 500 (reported repro:
 * `GET /api/tasks/FN-8610/runtime-fallback` returned 500 with the body
 * `{"error":"Task FN-8610 not found"}` — a 404 wearing a 500 status).
 *
 * The fix is the typed `TaskNotFoundError` thrown by `getTaskImpl` in
 * `@fusion/core`. This module is the single mapping seam every route catch
 * shares, so the ~40 affected handlers cannot drift apart again (AGENTS.md
 * "Reuse Components, Design Tokens, and Systems" / "Fix the Invariant, Not the
 * Repro"). The legacy ENOENT test is deliberately retained as a second, harmless
 * signal so genuinely file-backed reads (attachments, session files, worktree
 * files) keep their 404 behavior.
 */
import { isTaskNotFoundError, TaskDeletedError } from "@fusion/core";
import { ApiError, notFound, rethrowAsApiError } from "../api-error.js";

/**
 * FNXC:TaskLookup404 2026-07-26-11:35:
 * True when `error` means "the task/file being read does not exist". Primary
 * signal is the typed `TaskNotFoundError`; the errno `ENOENT` check stays for
 * file-backed reads on the same handlers.
 */
export function isTaskLookupMiss(error: unknown): boolean {
  /*
   * FNXC:TaskLookup404 2026-07-29-16:10:
   * Soft-deleted tasks are absent from the live API even when a mutation reports the tombstone with TaskDeletedError. Preserve structural matching for duplicated bundled/workspace core instances.
   */
  if (isTaskNotFoundError(error) || error instanceof TaskDeletedError) return true;
  if (error && typeof error === "object" && (error as { name?: unknown }).name === "TaskDeletedError") return true;
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/**
 * FNXC:TaskLookup404 2026-07-26-11:35:
 * Status selector for the `const status = ... ? 404 : 500` catch shape. Returns
 * 404 for a task/file miss, otherwise `fallbackStatus` (500 unless the handler
 * has its own more specific classification).
 */
export function taskLookupStatus(error: unknown, fallbackStatus = 500): number {
  return isTaskLookupMiss(error) ? 404 : fallbackStatus;
}

/**
 * FNXC:TaskLookup404 2026-07-26-11:35:
 * Drop-in replacement for `rethrowAsApiError` on any handler whose call path can
 * reach `store.getTask(...)`. Preserves an already-typed `ApiError`, maps a task
 * miss to 404, and defers everything else to the existing 500 behavior.
 *
 * The 404 message reuses the thrown error's own message (byte-identical to the
 * legacy `Task ${id} not found` string) so response bodies are unchanged for
 * clients that match on it; `taskId` is only a fallback when the error carried
 * no message.
 */
export function rethrowTaskApiError(
  error: unknown,
  taskId?: string,
  fallbackMessage?: string,
): never {
  if (error instanceof ApiError) {
    throw error;
  }
  if (isTaskLookupMiss(error)) {
    const message = error instanceof Error && error.message
      ? error.message
      : taskId
        ? `Task ${taskId} not found`
        : "Task not found";
    throw notFound(message);
  }
  rethrowAsApiError(error, fallbackMessage);
}
