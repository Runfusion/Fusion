import { DatabaseSync } from "./sqlite-adapter.js";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ArchivedTaskEntry } from "./types.js";
import { probeFts5 } from "./db.js";

const BASE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS archived_tasks (
  id TEXT PRIMARY KEY,
  taskJson TEXT NOT NULL,
  prompt TEXT,
  archivedAt TEXT NOT NULL,
  title TEXT,
  description TEXT NOT NULL,
  comments TEXT DEFAULT '[]',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  columnMovedAt TEXT
);

CREATE INDEX IF NOT EXISTS idxArchivedTasksArchivedAt ON archived_tasks(archivedAt);
CREATE INDEX IF NOT EXISTS idxArchivedTasksCreatedAt ON archived_tasks(createdAt);
`;

const FTS5_SCHEMA_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS archived_tasks_fts USING fts5(
  id,
  title,
  description,
  comments,
  content='archived_tasks',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS archived_tasks_fts_ai AFTER INSERT ON archived_tasks BEGIN
  INSERT INTO archived_tasks_fts(rowid, id, title, description, comments)
  VALUES (new.rowid, new.id, COALESCE(new.title, ''), new.description, COALESCE(new.comments, '[]'));
END;

CREATE TRIGGER IF NOT EXISTS archived_tasks_fts_au AFTER UPDATE OF id, title, description, comments ON archived_tasks BEGIN
  INSERT INTO archived_tasks_fts(archived_tasks_fts, rowid, id, title, description, comments)
    VALUES('delete', old.rowid, old.id, COALESCE(old.title, ''), old.description, COALESCE(old.comments, '[]'));
  INSERT INTO archived_tasks_fts(rowid, id, title, description, comments)
    VALUES (new.rowid, new.id, COALESCE(new.title, ''), new.description, COALESCE(new.comments, '[]'));
END;

CREATE TRIGGER IF NOT EXISTS archived_tasks_fts_ad AFTER DELETE ON archived_tasks BEGIN
  INSERT INTO archived_tasks_fts(archived_tasks_fts, rowid, id, title, description, comments)
    VALUES('delete', old.rowid, old.id, COALESCE(old.title, ''), old.description, COALESCE(old.comments, '[]'));
END;
`;

export class ArchiveDatabase {
  private db: DatabaseSync;
  private readonly _fts5Available: boolean;

  constructor(fusionDir: string) {
    if (!existsSync(fusionDir)) {
      mkdirSync(fusionDir, { recursive: true });
    }
    this.db = new DatabaseSync(join(fusionDir, "archive.db"));
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this._fts5Available = probeFts5(this.db);
  }

  /** True when this SQLite build has FTS5. See db.ts#probeFts5. */
  get fts5Available(): boolean {
    return this._fts5Available;
  }

  init(): void {
    this.db.exec(BASE_SCHEMA_SQL);
    if (this._fts5Available) {
      this.db.exec(FTS5_SCHEMA_SQL);
    }
    this.addColumnIfMissing("archived_tasks", "prompt", "TEXT");
  }

  upsert(entry: ArchivedTaskEntry): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO archived_tasks
        (id, taskJson, prompt, archivedAt, title, description, comments, createdAt, updatedAt, columnMovedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id,
      JSON.stringify(entry),
      entry.prompt ?? null,
      entry.archivedAt,
      entry.title ?? null,
      entry.description,
      JSON.stringify(entry.comments ?? []),
      entry.createdAt,
      entry.updatedAt,
      entry.columnMovedAt ?? null,
    );
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!rows.some((row) => row.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  list(): ArchivedTaskEntry[] {
    const rows = this.db.prepare(`
      SELECT taskJson FROM archived_tasks
      ORDER BY archivedAt DESC
    `).all() as Array<{ taskJson: string }>;
    return rows.map((row) => JSON.parse(row.taskJson) as ArchivedTaskEntry);
  }

  get(id: string): ArchivedTaskEntry | undefined {
    const row = this.db.prepare("SELECT taskJson FROM archived_tasks WHERE id = ?").get(id) as
      | { taskJson: string }
      | undefined;
    return row ? JSON.parse(row.taskJson) as ArchivedTaskEntry : undefined;
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM archived_tasks WHERE id = ?").run(id);
  }

  /**
   * Full-text search over archived tasks. Accepts a raw user query and routes
   * through FTS5 when available, or a LIKE-based scan when not.
   */
  search(query: string, limit: number): ArchivedTaskEntry[] {
    const trimmed = query?.trim();
    if (!trimmed) return [];

    const tokens = trimmed
      .split(/\s+/)
      .filter((t) => t.length > 0)
      .map((t) => t.replace(/["{}:*^+()]/g, ""))
      .filter((t) => t.length > 0);
    if (tokens.length === 0) return [];

    if (this._fts5Available) {
      const ftsQuery = tokens
        .map((token) => {
          if (/[":(){}*^+-]/.test(token)) {
            return `"${token.replace(/"/g, '\\"')}"`;
          }
          return token;
        })
        .join(" OR ");
      const rows = this.db.prepare(`
        SELECT a.taskJson
        FROM archived_tasks a
        JOIN archived_tasks_fts fts ON a.rowid = fts.rowid
        WHERE archived_tasks_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, limit) as Array<{ taskJson: string }>;
      return rows.map((row) => JSON.parse(row.taskJson) as ArchivedTaskEntry);
    }

    // LIKE fallback
    const searchColumns = ["id", "title", "description", "comments"];
    const perTokenClause = `(${searchColumns
      .map((c) => `"${c}" LIKE ? ESCAPE '\\'`)
      .join(" OR ")})`;
    const whereTokens = tokens.map(() => perTokenClause).join(" OR ");
    const params: (string | number)[] = [];
    for (const token of tokens) {
      const pattern = `%${token.replace(/[\\%_]/g, "\\$&")}%`;
      for (let i = 0; i < searchColumns.length; i++) params.push(pattern);
    }
    params.push(limit);
    const rows = this.db.prepare(`
      SELECT taskJson
      FROM archived_tasks
      WHERE ${whereTokens}
      ORDER BY archivedAt DESC
      LIMIT ?
    `).all(...params) as Array<{ taskJson: string }>;
    return rows.map((row) => JSON.parse(row.taskJson) as ArchivedTaskEntry);
  }

  close(): void {
    this.db.close();
  }
}
