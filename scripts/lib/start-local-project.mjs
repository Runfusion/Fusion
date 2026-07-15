import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * FNXC:LocalStartupPostgresMigration 2026-07-14-21:20:
 * Local startup recognizes both the PostgreSQL-era identity marker and a legacy SQLite database. The latter remains read-only migration input and must prevent a destructive fresh-initialization classification when project.json has not been materialized yet.
 */
export function hasLocalProjectMigrationInput(rootDir) {
  return existsSync(resolve(rootDir, ".fusion/project.json"))
    || existsSync(resolve(rootDir, ".fusion/fusion.db"));
}
