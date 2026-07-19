import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * FNXC:LocalStartupPostgresMigration 2026-07-14-22:25:
 * Local startup recognizes both the PostgreSQL-era identity marker and a valid legacy SQLite database. Legacy input must pass the canonical read-only SQLite probe so malformed paths do not suppress initialization; an intentional zero-byte bootstrap file remains valid migration input.
 */
export function hasLocalProjectMigrationInput(rootDir) {
  return existsSync(resolve(rootDir, ".fusion/project.json"))
    || isValidLegacySqliteInput(resolve(rootDir, ".fusion/fusion.db"));
}

function isValidLegacySqliteInput(dbPath) {
  if (!existsSync(dbPath)) return false;

  try {
    const stats = statSync(dbPath);
    if (!stats.isFile()) return false;
    if (stats.size === 0) return true;
  } catch {
    return false;
  }

  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.prepare("PRAGMA schema_version").get();
    return true;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}
