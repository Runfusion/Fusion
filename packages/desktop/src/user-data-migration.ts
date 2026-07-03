import { cpSync, existsSync, readdirSync } from "node:fs";

/*
FNXC:DesktopUserDataMigration 2026-07-03-15:10:
Relocating the Electron desktop profile to ~/.fusion/desktop-user-data (field report Issue 8) would silently orphan an existing operator's window geometry, sign-in session, and local storage under the OLD default Chromium profile (`<appData>/<productName>`). This performs a one-time COPY of the previous default profile into the new location, gated so it runs only on the first launch after upgrade: the new dir must be absent/empty and the old dir must exist, be non-empty, and be distinct. Copy (not move) so a failed/partial migration or a downgrade still finds the original profile intact. Best-effort: any failure returns false and the caller falls back to a fresh profile rather than blocking startup.
*/

function isMissingOrEmptyDir(dir: string): boolean {
  try {
    return readdirSync(dir).length === 0;
  } catch {
    // ENOENT (or unreadable) → treat as missing so we do not block on it.
    return true;
  }
}

/**
 * One-time copy of a previous Electron userData profile into `newDir`.
 * @returns `true` if a migration copy was performed, `false` otherwise (already
 * migrated, nothing to migrate, same path, or the copy failed).
 */
export function migratePreviousUserData(previousDir: string, newDir: string): boolean {
  try {
    if (previousDir === newDir) return false;
    if (!isMissingOrEmptyDir(newDir)) return false; // already migrated / has its own data
    if (!existsSync(previousDir) || isMissingOrEmptyDir(previousDir)) return false;
    cpSync(previousDir, newDir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}
