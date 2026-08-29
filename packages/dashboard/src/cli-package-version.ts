import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PACKAGE_NAME = "@runfusion/fusion";
const DESKTOP_PACKAGE_NAME = "@fusion/desktop";
const CLI_PACKAGE_NAMES = new Set([CLI_PACKAGE_NAME]);
const DESKTOP_PACKAGE_NAMES = new Set([DESKTOP_PACKAGE_NAME]);

export interface CliPackageVersionInfo {
  packageJsonPath: string;
  version: string;
}

function readPackageVersion(pkgPath: string, packageNames: ReadonlySet<string>): CliPackageVersionInfo | null {
  if (!existsSync(pkgPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(pkgPath, "utf-8")) as { name?: string; version?: string };
    if (parsed.name && packageNames.has(parsed.name) && typeof parsed.version === "string" && parsed.version.length > 0) {
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

function readCliPackageVersion(pkgPath: string): CliPackageVersionInfo | null {
  return readPackageVersion(pkgPath, CLI_PACKAGE_NAMES);
}

function readDesktopPackageVersion(pkgPath: string): CliPackageVersionInfo | null {
  return readPackageVersion(pkgPath, DESKTOP_PACKAGE_NAMES);
}

/**
 * Resolve the published CLI package version from dashboard code.
 *
 * Supported layouts:
 * - Monorepo source: `packages/dashboard/src/...` with sibling `packages/cli/package.json`
 * - Installed dependency: `node_modules/@runfusion/fusion/dist/...`
 * - Bundled CLI: dashboard code inlined into `dist/bin.js` next to the CLI manifest
 * - Packaged Desktop: `node_modules/@fusion/dashboard/dist/...` under the staged `@fusion/desktop` app manifest
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

  /*
   * FNXC:DesktopUpdates 2026-07-03-15:30:
   * Desktop embeds @fusion/dashboard inside a staged @fusion/desktop deploy tree, not inside the published @runfusion/fusion package. The dashboard npm update banner still compares against @runfusion/fusion releases, so use the desktop app manifest as the deterministic packaged-runtime version fallback after CLI-specific probes fail; never use the private @fusion/dashboard version for user-facing update availability.
   */
  currentDir = startDir;
  for (let i = 0; i < 8; i += 1) {
    const versionInfo = readDesktopPackageVersion(resolve(currentDir, "package.json"));
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

export function isUnresolvedCliPackageVersion(version: string): boolean {
  return version === "0.0.0";
}

export function getCliPackageVersion(importMetaUrl: string = import.meta.url): string {
  const startDir = dirname(fileURLToPath(importMetaUrl));
  return resolveCliPackageVersionInfo(startDir)?.version ?? process.env.npm_package_version ?? "0.0.0";
}
