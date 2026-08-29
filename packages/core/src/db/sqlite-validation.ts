import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "./sqlite-adapter.js";

/**
 * Validate that a path points to a SQLite database file that can be opened.
 *
 * This legacy-migration probe is read-only. A zero-byte bootstrap file remains
 * a valid migration signal, while non-existent, unreadable, or malformed files
 * return false. PostgreSQL-era startup never creates or upgrades a SQLite file
 * as a side effect of project discovery.
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
    // FNXC:LegacySqliteBoundary 2026-07-14-18:42: validation may inspect a legacy migration input but must never mutate it.
    db = new DatabaseSync(dbPath, { readOnly: true });
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
