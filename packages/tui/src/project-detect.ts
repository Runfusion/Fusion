/**
 * Project directory detection for the TUI package.
 *
 * Provides lightweight filesystem-based detection of Fusion projects
 * by walking up the directory tree looking for `.fusion/fusion.db`.
 * This mirrors the behavior used by the CLI but without depending on
 * CentralCore or CLI modules.
 */

import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";

/**
 * Detect the Fusion project root directory by walking up from a starting path.
 *
 * Walks up the directory tree starting from `startPath` (or `process.cwd()` by default)
 * looking for `.fusion/fusion.db`. Returns the project root directory (parent of `.fusion/`)
 * when found, or `null` if no project directory is detected up to the filesystem root.
 *
 * @param startPath - Starting directory for the search (defaults to process.cwd())
 * @returns The absolute path to the project root, or null if not found
 *
 * @example
 * // Find project from current directory
 * const projectPath = detectProjectDir();
 *
 * // Find project from a specific directory
 * const projectPath = detectProjectDir("/Users/me/code/my-project/src");
 * // Returns "/Users/me/code/my-project" if .fusion/fusion.db exists there
 */
export function detectProjectDir(startPath?: string): string | null {
  let currentDir = resolve(startPath ?? process.cwd());

  while (true) {
    // Check for Fusion database file
    const dbPath = resolve(currentDir, ".fusion", "fusion.db");
    if (existsSync(dbPath)) {
      return currentDir;
    }

    // Move up to parent directory
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      // Reached filesystem root, stop
      break;
    }
    currentDir = parentDir;
  }

  return null;
}
