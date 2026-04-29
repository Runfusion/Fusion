import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "./sqlite-adapter.js";

/**
 * Validate that a path points to a SQLite database file that can be opened.
 *
 * Zero-byte files are treated as valid bootstrap databases because SQLite
 * upgrades them in place on first open. Non-existent paths and unreadable or
 * malformed files return false.
 */
export function isValidSqliteDatabaseFile(dbPath: string): boolean {
  if (!existsSync(dbPath)) {
    return false;
  }

  try {
    if (!statSync(dbPath).isFile()) {
      return false;
    }
  } catch {
    return false;
  }

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath);
    db.prepare("PRAGMA schema_version").get();
    return true;
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      // Best-effort close only.
    }
  }
}
