import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Cached app version once resolved.
 */
let cachedVersion: string | null = null;

/**
 * Get the current Fusion application version by reading the nearest package.json.
 * Walks up from the current file to find the root package.json.
 * Results are cached for the process lifetime.
 *
 * @returns Semver version string (e.g., "0.1.0")
 */
export function getAppVersion(): string {
  if (cachedVersion !== null) return cachedVersion;

  // Start from this file's directory and walk up
  const __dirname = dirname(fileURLToPath(import.meta.url));
  let currentDir = __dirname;

  // Walk up to 10 levels looking for package.json
  for (let i = 0; i < 10; i++) {
    try {
      const pkgPath = join(currentDir, "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.version && typeof pkg.version === "string") {
        cachedVersion = pkg.version;
        return pkg.version;
      }
    } catch {
      // package.json not found or not parseable — continue walking up
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) break; // Reached filesystem root
    currentDir = parentDir;
  }

  // Fallback if no package.json found
  cachedVersion = "0.0.0";
  return cachedVersion;
}

/**
 * Parse a semver string into its components.
 * Supports basic semver format: MAJOR.MINOR.PATCH with optional prerelease suffix.
 * The string must match the pattern starting from the beginning.
 *
 * @param version - Semver version string (e.g., "1.2.3", "1.2.3-beta.1")
 * @returns Parsed components or null if invalid
 */
export function parseSemver(version: string): { major: number; minor: number; patch: number } | null {
  // Strict semver regex: anchored to start, requires MAJOR.MINOR.PATCH, allows optional prerelease/build
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}
