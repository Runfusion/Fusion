import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database, DatabaseSync, type TaskStore } from "@fusion/core";

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
  degraded: boolean;
  reason?: string;
}

const MAX_DEPTH = 5;
const MAX_IDS = 50;

function getDbPath(projectDir: string): string {
  return join(projectDir, ".fusion", "fusion.db");
}

function getColumns(db: DatabaseSync, table: "tasks" | "task_documents"): string[] {
  const rows = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name?: string }>;
  return rows.map((row) => row.name).filter((name): name is string => typeof name === "string" && name.length > 0);
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
  const fusionDir = join(worktreePath, ".fusion");
  mkdirSync(fusionDir, { recursive: true });
  const db = new Database(fusionDir);
  db.init();
  db.close();
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
    return { tasksCopied: 0, documentsCopied: 0, degraded: false, reason: "root_worktree" };
  }

  let srcDb: DatabaseSync | undefined;
  let dstDb: DatabaseSync | undefined;

  try {
    const ids = await resolveDependencyIds(taskId, store);
    if (ids.length === 0) {
      return { tasksCopied: 0, documentsCopied: 0, degraded: false, reason: "no_ids" };
    }

    const srcDbPath = getDbPath(rootDir);
    const dstDbPath = getDbPath(worktreePath);

    if (!existsSync(srcDbPath)) {
      return { tasksCopied: 0, documentsCopied: 0, degraded: true, reason: "source_db_missing" };
    }

    if (!existsSync(dstDbPath)) {
      ensureWorktreeSchema(worktreePath);
    }

    srcDb = new DatabaseSync(srcDbPath);
    srcDb.exec("PRAGMA busy_timeout = 5000");
    dstDb = openWorktreeDbWithRecovery(dstDbPath, worktreePath);

    dstDb.exec("PRAGMA busy_timeout = 5000");
    dstDb.exec("PRAGMA journal_mode = WAL");

    const srcTaskCols = getColumns(srcDb, "tasks");
    const dstTaskCols = getColumns(dstDb, "tasks");
    const srcDocCols = getColumns(srcDb, "task_documents");
    const dstDocCols = getColumns(dstDb, "task_documents");

    const { shared: taskColumns, dropped: droppedTaskColumns } = intersectColumns(srcTaskCols, dstTaskCols);
    const { shared: docColumns, dropped: droppedDocColumns } = intersectColumns(srcDocCols, dstDocCols);

    if (taskColumns.length === 0 || docColumns.length === 0) {
      throw new Error("schema intersection empty");
    }

    const dropped = [...droppedTaskColumns.map((c) => `tasks.${c}`), ...droppedDocColumns.map((c) => `task_documents.${c}`)];
    if (dropped.length > 0) {
      logger.warn(`Worktree DB hydration dropped columns for ${taskId}: ${dropped.join(", ")}`);
    }

    const placeholders = ids.map(() => "?").join(", ");
    const taskColumnList = taskColumns.join(", ");
    const docColumnList = docColumns.join(", ");
    const taskValuePlaceholders = taskColumns.map(() => "?").join(", ");
    const docValuePlaceholders = docColumns.map(() => "?").join(", ");

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

    const insertTask = dstDb.prepare(
      `INSERT OR REPLACE INTO tasks (${taskColumnList}) VALUES (${taskValuePlaceholders})`,
    );
    const insertDocument = dstDb.prepare(
      `INSERT OR REPLACE INTO task_documents (${docColumnList}) VALUES (${docValuePlaceholders})`,
    );

    dstDb.exec("BEGIN IMMEDIATE");
    try {
      for (const row of taskRows) {
        insertTask.run(...taskColumns.map((column) => row[column]));
      }
      for (const row of documentRows) {
        insertDocument.run(...docColumns.map((column) => row[column]));
      }
      dstDb.exec("COMMIT");
    } catch (error) {
      dstDb.exec("ROLLBACK");
      throw error;
    }

    return {
      tasksCopied: taskRows.length,
      documentsCopied: documentRows.length,
      degraded: false,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(`Worktree DB hydration failed for ${taskId}: ${reason} (${worktreePath})`);
    return {
      tasksCopied: 0,
      documentsCopied: 0,
      degraded: true,
      reason,
    };
  } finally {
    srcDb?.close();
    dstDb?.close();
  }
}
