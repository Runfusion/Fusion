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
  // First pass: walk ancestors looking for the @runfusion/fusion package.json directly.
  // This is the only path used in production (dashboard code is bundled into bin.js,
  // so import.meta.url lives inside the cli package) and matches the TUI's resolver
  // (packages/cli/src/commands/dashboard-tui/logo.ts:readFusionVersion) exactly so the
  // header/splash version and the dashboard /api/health version cannot drift.
  let currentDir = startDir;
  for (let i = 0; i < 8; i += 1) {
    const versionInfo = readCliPackageVersion(resolve(currentDir, "package.json"));
    if (versionInfo) {
      return versionInfo;
    }
    const parentDir = resolve(currentDir, "..");
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  // Second pass: dashboard-source dev mode. The dashboard package lives next to the
  // cli package under packages/, so probe the sibling cli manifest while walking up.
  currentDir = startDir;
  for (let i = 0; i < 8; i += 1) {
    const versionInfo = readCliPackageVersion(resolve(currentDir, "..", "cli", "package.json"));
    if (versionInfo) {
      return versionInfo;
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
