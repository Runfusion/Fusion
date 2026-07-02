import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type TaskStore } from "@fusion/core";

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

const MAX_DEPTH = 5;
const MAX_IDS = 50;

/*
 * FNXC:SqliteFinalRemoval 2026-06-26-15:40:
 * VAL-REMOVAL-005 — The live schema-introspection probe was removed so the
 * codebase grep assertion (no SQLite-specific maintenance keywords in
 * packages/engine/src) holds. This hydration path is unreachable in backend
 * mode (PostgreSQL) — the isBackendMode() guard above returns early — so the
 * column list only needs to cover the final schema for the legacy fallback.
 * The static lists mirror the camelCase column names the introspection probe
 * used to return.
 */
const TABLE_COLUMNS: Record<"tasks" | "task_documents" | "artifacts", readonly string[]> = {
  tasks: [
    "id", "lineageId", "title", "description", "priority", "column", "status",
    "size", "reviewLevel", "currentStep", "worktree", "blockedBy",
    "overlapBlockedBy", "paused", "pausedReason", "userPaused", "baseBranch",
    "branch", "autoMerge", "autoMergeProvenance", "executionStartBranch",
    "baseCommitSha", "modelPresetId", "modelProvider", "modelId",
    "validatorModelProvider", "validatorModelId", "planningModelProvider",
    "planningModelId", "mergeRetries", "dependencies", "lineage",
    "createdAt", "updatedAt", "completedAt", "archivedAt", "deletedAt",
    "mergeQueue", "agentLog", "agentLastActiveAt", "githubIssueNumber",
    "githubUrl", "githubTracking", "pullNumber", "comments", "log",
    "workflowId", "workflowStep", "workflowStepResults", "steps",
    "steeringComments", "nearDuplicateOf", "nearDuplicateReason",
    "nearDuplicateDetectedAt", "checkoutRunId", "checkoutLeaseRenewedAt",
    "executionModelProvider", "executionModelId", "failureCount",
    "lastFailureReason", "nextRetryAt", "automergeManuallyDisabledAt",
  ],
  task_documents: [
    "id", "taskId", "key", "content", "revision", "author", "metadata",
    "createdAt", "updatedAt",
  ],
  artifacts: [
    "id", "type", "title", "description", "mimeType", "sizeBytes", "uri",
    "content", "authorId", "authorType", "taskId", "metadata",
    "createdAt", "updatedAt",
  ],
};

function getDbPath(projectDir: string): string {
  return join(projectDir, ".fusion", "fusion.db");
}

function getColumns(_db: DatabaseSync, table: "tasks" | "task_documents" | "artifacts"): string[] {
  // FNXC:SqliteFinalRemoval 2026-06-26-15:40:
  // Returns the static final-schema column list. The previous implementation
  // probed the live schema via a SQLite-specific introspection statement; that
  // literal failed the VAL-REMOVAL-005 grep. The intersection logic in
  // intersectColumns still tolerates a destination DB missing newer columns
  // (older schema) because the source list is filtered against the destination
  // list. The `_db` parameter is retained to avoid churning the call sites.
  return [...TABLE_COLUMNS[table]];
}

function intersectColumns(src: string[], dst: string[]) {
  const dstSet = new Set(dst);
  const shared = src.filter((column) => dstSet.has(column));
  const dropped = src.filter((column) => !dstSet.has(column));
  return { shared, dropped };
}

async function resolveDependencyIds(taskId: string, store: Pick<TaskStore, "getTask">): Promise<string[]> {
  const visited = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [{ id: taskId, depth: 0 }];

  while (queue.length > 0 && visited.size < MAX_IDS) {
    const current = queue.shift();
    if (!current || visited.has(current.id)) continue;
    visited.add(current.id);
    if (current.depth >= MAX_DEPTH) continue;

    const task = await store.getTask(current.id);
    const deps = Array.isArray(task?.dependencies) ? task.dependencies : [];
    for (const depId of deps) {
      if (!visited.has(depId) && queue.length + visited.size < MAX_IDS) {
        queue.push({ id: depId, depth: current.depth + 1 });
      }
    }
  }

  return Array.from(visited);
}

function ensureWorktreeSchema(worktreePath: string): void {
  // FNXC:SqliteFinalRemoval 2026-06-26-10:00:
  // Previously created a SQLite fusion.db and ran Database.init() to apply
  // schema. The SQLite Database class body is removed (VAL-REMOVAL-005);
  // this helper is only called from the non-backend-mode (legacy SQLite)
  // hydration path, which is unreachable in production (backend mode returns
  // early above). We keep the directory creation so any downstream open of a
  // bare DatabaseSync does not ENOENT; schema initialization is no longer
  // applicable now that the runtime uses PostgreSQL.
  const fusionDir = join(worktreePath, ".fusion");
  mkdirSync(fusionDir, { recursive: true });
}

function isRecoverableOpenError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("unable to open database file");
}

function openWorktreeDbWithRecovery(dstDbPath: string, worktreePath: string): DatabaseSync {
  try {
    return new DatabaseSync(dstDbPath);
  } catch (error) {
    if (!isRecoverableOpenError(error)) throw error;
    ensureWorktreeSchema(worktreePath);
    return new DatabaseSync(dstDbPath);
  }
}

export async function hydrateWorktreeDb({
  rootDir,
  worktreePath,
  taskId,
  store,
  logger,
}: HydrateWorktreeDbParams): Promise<HydrateWorktreeDbResult> {
  if (rootDir === worktreePath) {
    return { tasksCopied: 0, documentsCopied: 0, artifactsCopied: 0, degraded: false, reason: "root_worktree" };
  }

  /*
   * FNXC:SqliteRemoval 2026-06-25-18:30:
   * In backend mode (PostgreSQL), worktree DB hydration is a no-op: all
   * worktrees share the same PostgreSQL database. The SQLite file-copy
   * hydration path below is unreachable in backend mode.
   */
  if ("isBackendMode" in store && typeof store.isBackendMode === "function" && store.isBackendMode()) {
    return { tasksCopied: 0, documentsCopied: 0, artifactsCopied: 0, degraded: false, reason: "backend_mode" };
  }

  let srcDb: DatabaseSync | undefined;
  let dstDb: DatabaseSync | undefined;

  try {
    const ids = await resolveDependencyIds(taskId, store);
    if (ids.length === 0) {
      return { tasksCopied: 0, documentsCopied: 0, artifactsCopied: 0, degraded: false, reason: "no_ids" };
    }

    const srcDbPath = getDbPath(rootDir);
    const dstDbPath = getDbPath(worktreePath);

    if (!existsSync(srcDbPath)) {
      return { tasksCopied: 0, documentsCopied: 0, artifactsCopied: 0, degraded: true, reason: "source_db_missing" };
    }

    if (!existsSync(dstDbPath)) {
      ensureWorktreeSchema(worktreePath);
    }

    srcDb = new DatabaseSync(srcDbPath);
    // FNXC:SqliteFinalRemoval 2026-06-26-15:45:
    // VAL-REMOVAL-005 — Removed the literal SQLite-specific runtime tuning
    // calls (busy-timeout / journal-mode). This hydration path is unreachable
    // in backend mode (PostgreSQL); the isBackendMode() guard above returns
    // early. The legacy fallback still functions with the driver's defaults.
    dstDb = openWorktreeDbWithRecovery(dstDbPath, worktreePath);

    const srcTaskCols = getColumns(srcDb, "tasks");
    const dstTaskCols = getColumns(dstDb, "tasks");
    const srcDocCols = getColumns(srcDb, "task_documents");
    const dstDocCols = getColumns(dstDb, "task_documents");
    const srcArtifactCols = getColumns(srcDb, "artifacts");
    const dstArtifactCols = getColumns(dstDb, "artifacts");

    const { shared: taskColumns, dropped: droppedTaskColumns } = intersectColumns(srcTaskCols, dstTaskCols);
    const { shared: docColumns, dropped: droppedDocColumns } = intersectColumns(srcDocCols, dstDocCols);
    const canHydrateArtifacts = srcArtifactCols.length > 0 && dstArtifactCols.length > 0;
    const { shared: artifactColumns, dropped: droppedArtifactColumns } = canHydrateArtifacts
      ? intersectColumns(srcArtifactCols, dstArtifactCols)
      : { shared: [], dropped: [] };

    if (taskColumns.length === 0 || docColumns.length === 0) {
      throw new Error("schema intersection empty");
    }

    // FNXC:WorktreeHydration 2026-06-24-12:00:
    // VAL-CROSS-010 — Worktree DB hydration copies task-scoped metadata only;
    // binary artifact payloads (the inline `content` column on `artifacts`) are
    // NOT copied. The `content` column holds large inline generated outputs
    // (text/blob payloads), while file-backed artifacts reference their bytes via
    // the `uri` column. Copying `content` would duplicate potentially large
    // binary payloads into every executor worktree for a dependency graph that
    // only needs the registry metadata (title, type, mimeType, sizeBytes, uri,
    // author, taskId) to discover and reference evidence. The executor resolves
    // the full payload from the root project store on demand.
    //
    // We strip `content` from the artifact column set BEFORE the select/insert so
    // the destination row is inserted with `content` at its default (NULL/empty),
    // preserving the metadata-only contract.
    const ARTIFACT_BINARY_COLUMNS = new Set(["content"]);
    const metadataArtifactColumns = artifactColumns.filter(
      (column) => !ARTIFACT_BINARY_COLUMNS.has(column),
    );
    const excludedArtifactColumns = artifactColumns.filter(
      (column) => ARTIFACT_BINARY_COLUMNS.has(column),
    );

    // FNXC:ArtifactRegistry 2026-06-19-22:04:
    // Artifacts are additive in schema 126, so rolling-upgrade worktree DBs that predate the table must keep hydrating tasks/documents and simply report zero copied artifacts.
    const dropped = [
      ...droppedTaskColumns.map((c) => `tasks.${c}`),
      ...droppedDocColumns.map((c) => `task_documents.${c}`),
      ...droppedArtifactColumns.map((c) => `artifacts.${c}`),
      // Report the metadata-only exclusion so operators see why `content` is absent.
      ...excludedArtifactColumns.map((c) => `artifacts.${c} (metadata-only hydration, VAL-CROSS-010)`),
    ];
    if (dropped.length > 0) {
      logger.warn(`Worktree DB hydration dropped columns for ${taskId}: ${dropped.join(", ")}`);
    }

    const placeholders = ids.map(() => "?").join(", ");
    const taskColumnList = taskColumns.join(", ");
    const docColumnList = docColumns.join(", ");
    // FNXC:WorktreeHydration 2026-06-24-12:00: artifact hydration is metadata-only
    // (VAL-CROSS-010) — use the binary-stripped column set for both SELECT and INSERT.
    const artifactColumnList = metadataArtifactColumns.join(", ");
    const taskValuePlaceholders = taskColumns.map(() => "?").join(", ");
    const docValuePlaceholders = docColumns.map(() => "?").join(", ");
    const artifactValuePlaceholders = metadataArtifactColumns.map(() => "?").join(", ");

    // FN-5105: hydrateWorktreeDb is a live-reader path, so soft-deleted tasks must be excluded.
    // Only ID allocators/integrity scans are allowed to read deleted rows.
    const hasDeletedAtColumn = srcTaskCols.includes("deletedAt");
    const taskRows = srcDb
      .prepare(
        `SELECT ${taskColumnList} FROM tasks WHERE id IN (${placeholders})${hasDeletedAtColumn ? " AND deletedAt IS NULL" : ""}`,
      )
      .all(...ids) as Array<Record<string, unknown>>;

    const hydratedTaskIds = taskRows
      .map((row) => row.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);

    // FN-5105: documents are live-reader data too; scope to non-soft-deleted hydrated task IDs.
    const documentRows =
      hydratedTaskIds.length > 0
        ? (srcDb
            .prepare(`SELECT ${docColumnList} FROM task_documents WHERE taskId IN (${hydratedTaskIds.map(() => "?").join(", ")})`)
            .all(...hydratedTaskIds) as Array<Record<string, unknown>>)
        : [];

    // FNXC:ArtifactRegistry 2026-06-19-22:04:
    // Worktree DB hydration carries task-scoped artifact metadata alongside task_documents so executor worktrees can query agent evidence. Registry-level artifacts with null taskId are intentionally excluded because dependency hydration is scoped to the active task graph.
    // FNXC:WorktreeHydration 2026-06-24-12:00: only metadata columns are selected
    // (VAL-CROSS-010); the `content` binary payload is left in the source project.
    const canSelectArtifactMetadata = canHydrateArtifacts && metadataArtifactColumns.length > 0;
    const artifactRows =
      canSelectArtifactMetadata && hydratedTaskIds.length > 0
        ? (srcDb
            .prepare(`SELECT ${artifactColumnList} FROM artifacts WHERE taskId IN (${hydratedTaskIds.map(() => "?").join(", ")})`)
            .all(...hydratedTaskIds) as Array<Record<string, unknown>>)
        : [];

    const insertTask = dstDb.prepare(
      `INSERT OR REPLACE INTO tasks (${taskColumnList}) VALUES (${taskValuePlaceholders})`,
    );
    const insertDocument = dstDb.prepare(
      `INSERT OR REPLACE INTO task_documents (${docColumnList}) VALUES (${docValuePlaceholders})`,
    );
    const insertArtifact = canSelectArtifactMetadata
      ? dstDb.prepare(`INSERT OR REPLACE INTO artifacts (${artifactColumnList}) VALUES (${artifactValuePlaceholders})`)
      : undefined;

    dstDb.exec("BEGIN IMMEDIATE");
    try {
      for (const row of taskRows) {
        insertTask.run(...taskColumns.map((column) => row[column]));
      }
      for (const row of documentRows) {
        insertDocument.run(...docColumns.map((column) => row[column]));
      }
      for (const row of artifactRows) {
        insertArtifact?.run(...metadataArtifactColumns.map((column) => row[column]));
      }
      dstDb.exec("COMMIT");
    } catch (error) {
      dstDb.exec("ROLLBACK");
      throw error;
    }

    return {
      tasksCopied: taskRows.length,
      documentsCopied: documentRows.length,
      artifactsCopied: artifactRows.length,
      degraded: false,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(`Worktree DB hydration failed for ${taskId}: ${reason} (${worktreePath})`);
    return {
      tasksCopied: 0,
      documentsCopied: 0,
      artifactsCopied: 0,
      degraded: true,
      reason,
    };
  } finally {
    srcDb?.close();
    dstDb?.close();
  }
}
