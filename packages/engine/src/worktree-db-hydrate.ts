import type { TaskStore } from "@fusion/core";

export interface HydrateWorktreeDbParams {
  rootDir: string;
  worktreePath: string;
  taskId: string;
  store: Pick<TaskStore, "getTask">;
  logger: { warn: (message: string) => void };
}

export interface HydrateWorktreeDbResult {
  tasksCopied: number;
  documentsCopied: number;
  artifactsCopied: number;
  degraded: boolean;
  reason?: string;
}

/**
 * FNXC:PostgresWorktreeStorage 2026-07-14-18:35:
 * Executor worktrees share the project-scoped PostgreSQL store. Worktree
 * acquisition must never create, open, or copy a local `.fusion/fusion.db`;
 * task, document, and artifact visibility comes from the shared store and its
 * project identity. The function remains as the acquisition seam so existing
 * callers can record storage readiness without maintaining a SQLite fallback.
 */
export async function hydrateWorktreeDb({
  rootDir,
  worktreePath,
}: HydrateWorktreeDbParams): Promise<HydrateWorktreeDbResult> {
  return {
    tasksCopied: 0,
    documentsCopied: 0,
    artifactsCopied: 0,
    degraded: false,
    reason: rootDir === worktreePath ? "root_worktree" : "postgres_shared_store",
  };
}
