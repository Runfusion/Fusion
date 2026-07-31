import { useEffect, useState } from "react";
import { fetchSessionFiles } from "../api";
import {
  isCompleteColumnRole,
  isReviewColumnRole,
  isWipColumnRole,
  type ColumnRoleFlags,
} from "../utils/columnRoles";

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-07:30 (dashboard-app feed):
Session files load for cards that HAVE a worktree — wip, review, and complete.

CENSUS-INVISIBLE: a `Set` literal is a definition, not a comparison, so nothing in the lifecycle
backlog pointed at this hook. Found by grepping for lane-shaped list literals.

On a renamed board the set matched nothing, so the Files tab was permanently EMPTY for every card
that had one — the fetch simply never fired. An empty file list is indistinguishable from a task
that touched no files, which is why this would never be reported as a bug.

DELIBERATE-LITERAL — the unresolved-flags default, reviewed 2026-07-31-07:30. `columnFlags` is
optional so every existing caller (and the hook's own test) is byte-identical; the role helpers in
`columnRoles.ts` own the legacy-id degraded mode.
*/
const LEGACY_ACTIVE_COLUMNS = new Set(["in-progress", "in-review", "done"]);

function hasWorktreeBearingRole(column: string, flags: ColumnRoleFlags | undefined): boolean {
  if (!flags) return LEGACY_ACTIVE_COLUMNS.has(column);
  return isWipColumnRole(flags, column)
    || isReviewColumnRole(flags, column)
    || isCompleteColumnRole(flags, column);
}

interface UseSessionFilesResult {
  files: string[];
  loading: boolean;
}

interface UseSessionFilesOptions {
  /** Enable fetching when true (default). Suppresses fetches for offscreen cards. */
  enabled?: boolean;
  /** Resolved trait flags for `column`. Omitted → the legacy ids, i.e. today's behaviour. */
  columnFlags?: ColumnRoleFlags;
}

/**
 * Fetches session files for tasks with active worktrees.
 *
 * @param taskId - Task identifier
 * @param worktree - Worktree path (undefined = no worktree)
 * @param column - Current task column
 * @param projectId - Optional project identifier
 * @param options.enabled - When false, no fetch is made and returns empty/stable state
 */
export function useSessionFiles(
  taskId: string,
  worktree: string | undefined,
  column: string,
  projectId?: string,
  options: UseSessionFilesOptions = {},
): UseSessionFilesResult {
  const enabled = options.enabled ?? true;
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-31-07:30 (dashboard-app feed):
  Collapsed to a BOOLEAN before the effect, deliberately. `columnFlags` is an object, and a caller
  building it inline hands this hook a new identity every render — putting it in the dep array below
  would refetch on every parent render. The derived boolean is stable for a stable answer.
  */
  const columnBearsWorktree = hasWorktreeBearingRole(column, options.columnFlags);
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Disabled state: return stable empty state without fetching
    if (!enabled) {
      setFiles([]);
      setLoading(false);
      return;
    }

    if (!taskId || !worktree || !columnBearsWorktree) {
      setFiles([]);
      setLoading(false);
      return;
    }

    const cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const result = await fetchSessionFiles(taskId, projectId);
        if (!cancelled) {
          setFiles(result);
        }
      } catch {
        if (!cancelled) {
          setFiles([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();
  }, [taskId, worktree, column, projectId, enabled, columnBearsWorktree]);

  return { files, loading };
}
