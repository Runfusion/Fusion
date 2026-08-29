import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CLI_PACKAGE_NAME = "@runfusion/fusion";
export const MAX_PACKAGE_LOOKUP_DEPTH = 8;

/**
 * FNXC:CliVersionResolution 2026-08-11-08:34:
 * The CLI bin, update command, and plugin scaffold formerly kept byte-equivalent
 * self-version walkers. Centralizing them prevents drift while each caller passes
 * its own import.meta.url so its resolution start directory remains unchanged.
 *
 * This must remain a built-ins-only leaf: bin resolves --version before app imports
 * so the dashboard CLI Binary probe cannot bootstrap the application. Its node:fs
 * surface is intentionally limited to existsSync/readFileSync because update tests
 * replace that module with only those APIs. The eight-level bound is pinned in both
 * directions by plugin-scaffold-caret-fallback.test.ts. Do not merge the dashboard
 * resolver or self-extension resolver: they have richer and different contracts.
 */
export function readOwnCliVersion(importMetaUrl: string = import.meta.url): string | undefined {
  let currentDir: string;
  try {
    currentDir = dirname(fileURLToPath(importMetaUrl));
  } catch {
    return undefined;
  }

  for (let i = 0; i < MAX_PACKAGE_LOOKUP_DEPTH; i += 1) {
    const pkgPath = resolve(currentDir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const parsed = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
          name?: string;
          version?: string;
        };
        if (parsed.name === CLI_PACKAGE_NAME && typeof parsed.version === "string") {
          return parsed.version;
        }
      } catch {
        // Ignore malformed manifest and keep walking.
      }
    }

    const parentDir = resolve(currentDir, "..");
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  return undefined;
}
