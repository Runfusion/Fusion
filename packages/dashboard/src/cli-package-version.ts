import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PACKAGE_NAME = "@runfusion/fusion";

export interface CliPackageVersionInfo {
  packageJsonPath: string;
  version: string;
}

function readCliPackageVersion(pkgPath: string): CliPackageVersionInfo | null {
  if (!existsSync(pkgPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(pkgPath, "utf-8")) as { name?: string; version?: string };
    if (parsed.name === CLI_PACKAGE_NAME && typeof parsed.version === "string" && parsed.version.length > 0) {
      return {
        packageJsonPath: pkgPath,
        version: parsed.version,
      };
    }
  } catch {
    // Ignore unreadable or malformed package manifests and keep searching.
  }

  return null;
}

/**
 * Resolve the published CLI package version from dashboard code.
 *
 * Supported layouts:
 * - Monorepo source: `packages/dashboard/src/...` with sibling `packages/cli/package.json`
 * - Installed dependency: `node_modules/@runfusion/fusion/dist/...`
 * - Bundled CLI: dashboard code inlined into `dist/bin.js` next to the CLI manifest
 */
export function resolveCliPackageVersionInfo(startDir: string): CliPackageVersionInfo | null {
  let currentDir = startDir;

  for (let i = 0; i < 8; i += 1) {
    const candidates = [
      resolve(currentDir, "package.json"),
      resolve(currentDir, "..", "cli", "package.json"),
    ];

    for (const pkgPath of candidates) {
      const versionInfo = readCliPackageVersion(pkgPath);
      if (versionInfo) {
        return versionInfo;
      }
    }

    const parentDir = resolve(currentDir, "..");
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return null;
}

export function getCliPackageVersion(importMetaUrl: string = import.meta.url): string {
  const startDir = dirname(fileURLToPath(importMetaUrl));
  return resolveCliPackageVersionInfo(startDir)?.version ?? process.env.npm_package_version ?? "0.0.0";
}
