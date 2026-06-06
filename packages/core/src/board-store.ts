/**
 * BoardStore — persistence for the company-model Board entity (U1).
 *
 * A Board is the first-class task container: it wraps a workflow config by
 * reference (`workflowId` → built-in or custom workflow id) and homes tasks
 * (`tasks.boardId`). Board containment is universal and unflagged — every task
 * gains a board at migration v114; company-model *semantics* (teams, movement
 * rules, CEO) stay behind `experimentalFeatures.companyModel` in later units.
 *
 * Distinct from the legacy `board.ts` transition/dependency utility — this is a
 * new, durable sub-store wired into the TaskStore the way MissionStore is.
 *
 * v1 surface is intentionally minimal: createBoard / getBoard / listBoards /
 * updateBoard / deleteBoard (guarded — a board with homed tasks cannot be
 * deleted). Richer board operations (team staffing, reordering UX) land in later
 * units.
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import type { Board, BoardCreateInput, BoardUpdate } from "./types.js";

/** Thrown when deleting a board that still homes one or more tasks (v1 guard). */
export class BoardHasTasksError extends Error {
  constructor(
    public readonly boardId: string,
    public readonly taskCount: number,
  ) {
    super(`Cannot delete board '${boardId}': ${taskCount} task(s) are still homed on it`);
    this.name = "BoardHasTasksError";
  }
}

interface BoardRow {
  id: string;
  projectId: string;
  name: string;
  description: string;
  workflowId: string;
  ordering: number;
  createdAt: string;
  updatedAt: string;
}

export type BoardStoreEvents = {
  "board:created": [Board];
  "board:updated": [Board];
  "board:deleted": [{ id: string }];
};

export class BoardStore extends EventEmitter<BoardStoreEvents> {
  constructor(
    private fusionDir: string,
    private db: Database,
    private taskStore?: import("./store.js").TaskStore,
  ) {
    super();
    this.setMaxListeners(100);
  }

  private rowToBoard(row: BoardRow): Board {
    return {
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      description: row.description ?? "",
      workflowId: row.workflowId,
      ordering: row.ordering,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** The stable project-identity id boards scope by. Falls back to the empty
   *  string (matching the migration's fresh-project default) when no identity row
   *  exists yet, so reads/writes share one project key per store instance. */
  private resolveProjectId(): string {
    try {
      return this.db.getProjectIdentity()?.id ?? "";
    } catch {
      return "";
    }
  }

  /** Create a Board. `description`/`ordering` default when omitted; ordering
   *  defaults to the end of the project's board list. */
  createBoard(input: BoardCreateInput): Board {
    const name = input.name?.trim();
    if (!name) throw new Error("Board name is required");
    const workflowId = input.workflowId?.trim();
    if (!workflowId) throw new Error("Board workflowId is required");
    const now = new Date().toISOString();
    const projectId = input.projectId ?? this.resolveProjectId();
    const ordering =
      input.ordering ??
      ((
        this.db
          .prepare("SELECT COALESCE(MAX(ordering), -1) + 1 AS next FROM boards WHERE projectId = ?")
          .get(projectId) as { next: number }
      ).next);
    const board: Board = {
      id: randomUUID(),
      projectId,
      name,
      description: input.description ?? "",
      workflowId,
      ordering,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO boards (id, projectId, name, description, workflowId, ordering, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        board.id,
        board.projectId,
        board.name,
        board.description,
        board.workflowId,
        board.ordering,
        board.createdAt,
        board.updatedAt,
      );
    this.emit("board:created", board);
    return board;
  }

  /** Get a board by id, or undefined when absent. */
  getBoard(id: string): Board | undefined {
    const row = this.db.prepare("SELECT * FROM boards WHERE id = ?").get(id) as BoardRow | undefined;
    return row ? this.rowToBoard(row) : undefined;
  }

  /** List the boards for a project, ordered by `ordering` ascending. Defaults to
   *  this store's resolved project id. */
  listBoards(projectId?: string): Board[] {
    const pid = projectId ?? this.resolveProjectId();
    const rows = this.db
      .prepare("SELECT * FROM boards WHERE projectId = ? ORDER BY ordering ASC, createdAt ASC")
      .all(pid) as BoardRow[];
    return rows.map((row) => this.rowToBoard(row));
  }

  /** Update a board. Only supplied fields are written; `updatedAt` is bumped. */
  updateBoard(id: string, updates: BoardUpdate): Board {
    const existing = this.getBoard(id);
    if (!existing) throw new Error(`Board '${id}' not found`);
    const next: Board = {
      ...existing,
      name: updates.name?.trim() || existing.name,
      description: updates.description ?? existing.description,
      workflowId: updates.workflowId?.trim() || existing.workflowId,
      ordering: updates.ordering ?? existing.ordering,
      updatedAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `UPDATE boards SET name = ?, description = ?, workflowId = ?, ordering = ?, updatedAt = ? WHERE id = ?`,
      )
      .run(next.name, next.description, next.workflowId, next.ordering, next.updatedAt, next.id);
    this.emit("board:updated", next);
    return next;
  }

  /** Count the tasks (non-deleted) still homed on a board. */
  countTasks(boardId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM tasks WHERE boardId = ? AND deletedAt IS NULL`)
      .get(boardId) as { c: number };
    return row.c;
  }

  /** Delete a board. Guarded: a board still homing tasks cannot be deleted
   *  (BoardHasTasksError). v1 — re-homing/replacement UX lands later. */
  deleteBoard(id: string): void {
    const count = this.countTasks(id);
    if (count > 0) throw new BoardHasTasksError(id, count);
    this.db.prepare("DELETE FROM boards WHERE id = ?").run(id);
    this.emit("board:deleted", { id });
  }
}
