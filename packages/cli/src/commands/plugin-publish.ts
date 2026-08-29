import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { FusionPlugin, PluginManifest } from "@fusion/core";
import { loadManifestFromPath, resolvePluginEntryFile } from "./plugin.js";

export type VersionBumpClass = "major" | "minor" | "patch" | "none" | "invalid";

export interface PluginPreflightCheck {
  name: string;
  status: "pass" | "fail" | "warn";
  detail: string;
}

export interface PluginPreflightReport {
  ok: boolean;
  manifest?: PluginManifest;
  entryPath?: string;
  declaredHooks: string[];
  versionBump: { class: VersionBumpClass; previous?: string; next: string } | null;
  checks: PluginPreflightCheck[];
}

interface PackageJsonWithVersion {
  version?: unknown;
}

const STRICT_SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/*
 * FNXC:PluginPublish 2026-07-12-00:00:
 * Plugin publish preflight is offline and non-mutating for external author readiness (G-MPS8FPMK-0001-SAWD). It reuses the install path's manifest and compiled-entrypoint checks so first-publish failures surface before packing without registry, tag, install, or lifecycle side effects.
 *
 * FNXC:PluginPublish 2026-07-12-00:00:
 * The bump classifier intentionally accepts only strict numeric x.y.z versions, matching validatePluginManifest. Downgrades are invalid because a publish preflight should not bless a version that cannot represent a forward release.
 */
export function classifyVersionBump(previous: string, next: string): VersionBumpClass {
  const previousMatch = STRICT_SEMVER.exec(previous);
  const nextMatch = STRICT_SEMVER.exec(next);
  if (!previousMatch || !nextMatch) {
    return "invalid";
  }

  const previousParts = previousMatch.slice(1).map(Number) as [number, number, number];
  const nextParts = nextMatch.slice(1).map(Number) as [number, number, number];

  if (nextParts[0] < previousParts[0]) return "invalid";
  if (nextParts[0] > previousParts[0]) return "major";

  if (nextParts[1] < previousParts[1]) return "invalid";
  if (nextParts[1] > previousParts[1]) return "minor";

  if (nextParts[2] < previousParts[2]) return "invalid";
  if (nextParts[2] > previousParts[2]) return "patch";

  return "none";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

async function readPackageJsonVersion(pluginDir: string): Promise<string | undefined> {
  const packageJsonPath = join(pluginDir, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf-8")) as PackageJsonWithVersion;
  return typeof packageJson.version === "string" ? packageJson.version : undefined;
}

function collectDeclaredFunctionHooks(
  value: unknown,
  prefix: string,
  checks: PluginPreflightCheck[],
): string[] {
  const hooksRecord = asRecord(value);
  if (!hooksRecord) return [];

  const declaredHooks: string[] = [];
  for (const [name, hook] of Object.entries(hooksRecord)) {
    if (hook === undefined) continue;
    const hookName = `${prefix}.${name}`;
    declaredHooks.push(hookName);
    if (typeof hook !== "function") {
      checks.push({
        name: "Lifecycle hooks",
        status: "fail",
        detail: `${hookName} must be a function.`,
      });
    }
  }
  return declaredHooks;
}

async function validateModuleShape(
  entryPath: string,
  manifest: PluginManifest,
  checks: PluginPreflightCheck[],
): Promise<string[]> {
  try {
    const imported = await import(pathToFileURL(entryPath).href);
    const plugin = imported.default as Partial<FusionPlugin> | undefined;
    const pluginRecord = asRecord(plugin);
    if (!pluginRecord) {
      checks.push({ name: "Plugin module", status: "fail", detail: "Default export must be a plugin object." });
      return [];
    }

    const moduleManifest = asRecord(pluginRecord.manifest);
    if (!moduleManifest) {
      checks.push({ name: "Plugin module", status: "fail", detail: "Default export must include manifest." });
    } else if (moduleManifest.id !== manifest.id || moduleManifest.version !== manifest.version) {
      checks.push({
        name: "Plugin module",
        status: "fail",
        detail: `Default export manifest id/version must match manifest.json (${manifest.id}@${manifest.version}).`,
      });
    } else {
      checks.push({ name: "Plugin module", status: "pass", detail: "Default export manifest matches manifest.json." });
    }

    const declaredHooks = [
      ...collectDeclaredFunctionHooks(pluginRecord.hooks, "hooks", checks),
      ...collectDeclaredFunctionHooks(asRecord(pluginRecord.setup)?.hooks, "setup.hooks", checks),
    ].sort();

    if (declaredHooks.length === 0) {
      checks.push({ name: "Lifecycle hooks", status: "warn", detail: "No lifecycle hooks declared." });
    } else if (!checks.some((check) => check.name === "Lifecycle hooks" && check.status === "fail")) {
      checks.push({
        name: "Lifecycle hooks",
        status: "pass",
        detail: `Declared hook functions: ${declaredHooks.join(", ")}.`,
      });
    }

    return declaredHooks;
  } catch (error) {
    checks.push({ name: "Plugin module", status: "fail", detail: errorMessage(error) });
    return [];
  }
}

export async function collectPluginPreflight(
  pluginDir: string,
  options?: { previousVersion?: string },
): Promise<PluginPreflightReport> {
  const checks: PluginPreflightCheck[] = [];
  let manifest: PluginManifest | undefined;
  let entryPath: string | undefined;
  let declaredHooks: string[] = [];
  let versionBump: PluginPreflightReport["versionBump"] = null;
  const absolutePluginDir = resolve(pluginDir);

  try {
    const loaded = await loadManifestFromPath(absolutePluginDir);
    manifest = loaded.manifest;
    checks.push({ name: "Manifest", status: "pass", detail: `manifest.json is valid for ${manifest.id}@${manifest.version}.` });
  } catch (error) {
    checks.push({ name: "Manifest", status: "fail", detail: errorMessage(error) });
  }

  try {
    entryPath = await resolvePluginEntryFile(absolutePluginDir);
    checks.push({ name: "Entrypoint", status: "pass", detail: `Resolved compiled entrypoint: ${entryPath}.` });
  } catch (error) {
    checks.push({ name: "Entrypoint", status: "fail", detail: errorMessage(error) });
  }

  if (manifest) {
    try {
      const packageVersion = await readPackageJsonVersion(absolutePluginDir);
      if (packageVersion === manifest.version) {
        checks.push({ name: "Package version", status: "pass", detail: `package.json version matches manifest.json (${manifest.version}).` });
      } else {
        checks.push({
          name: "Package version",
          status: "fail",
          detail: `package.json version (${packageVersion ?? "missing"}) must match manifest.json version (${manifest.version}).`,
        });
      }
    } catch (error) {
      checks.push({ name: "Package version", status: "fail", detail: errorMessage(error) });
    }
  }

  if (manifest && entryPath) {
    declaredHooks = await validateModuleShape(entryPath, manifest, checks);
  }

  if (manifest) {
    if (options?.previousVersion) {
      const bumpClass = classifyVersionBump(options.previousVersion, manifest.version);
      versionBump = { class: bumpClass, previous: options.previousVersion, next: manifest.version };
      checks.push({
        name: "Version bump",
        status: bumpClass === "invalid" ? "fail" : "pass",
        detail: bumpClass === "invalid"
          ? `Cannot classify ${options.previousVersion} → ${manifest.version}; use strict semver and do not downgrade.`
          : `Classified ${options.previousVersion} → ${manifest.version} as ${bumpClass}.`,
      });
    } else {
      versionBump = null;
      checks.push({
        name: "Version bump",
        status: "warn",
        detail: "Pass --previous-version to classify the bump.",
      });
    }
  }

  return {
    ok: !checks.some((check) => check.status === "fail"),
    manifest,
    entryPath,
    declaredHooks,
    versionBump,
    checks,
  };
}

function statusIcon(status: PluginPreflightCheck["status"]): string {
  if (status === "pass") return "✓";
  if (status === "warn") return "⚠";
  return "✗";
}

export async function runPluginPublish(
  source: string,
  options?: { dryRun?: boolean; previousVersion?: string; projectName?: string },
): Promise<void> {
  if (!existsSync(source)) {
    console.error(`Plugin path does not exist: ${source}`);
    process.exit(1);
  }

  const pluginDir = resolve(source);
  const report = await collectPluginPreflight(pluginDir, { previousVersion: options?.previousVersion });

  console.log("Plugin publish preflight");
  console.log(`  Path: ${pluginDir}`);
  console.log(`  Mode: ${options?.dryRun ? "dry-run" : "preflight-only"}`);
  for (const check of report.checks) {
    console.log(`  ${statusIcon(check.status)} ${check.name.padEnd(16)} ${check.detail}`);
  }
  if (report.entryPath) {
    console.log(`  Entry: ${report.entryPath}`);
  }
  console.log(`  Hooks: ${report.declaredHooks.length > 0 ? report.declaredHooks.join(", ") : "none declared"}`);
  if (report.versionBump) {
    console.log(`  Version bump: ${report.versionBump.previous} → ${report.versionBump.next} (${report.versionBump.class})`);
  } else if (report.manifest) {
    console.log("  Version bump: not classified (pass --previous-version <semver>)");
  }

  if (!report.ok) {
    console.error("Plugin publish preflight failed. Fix the failing checks before packing or publishing.");
    process.exit(1);
  }

  console.log("Plugin publish preflight passed. Fusion did not install, upload, publish, or tag anything.");
  if (!options?.dryRun) {
    console.log("Fusion does not upload or tag plugins on your behalf; run the manual publish steps yourself when ready.");
  }
  console.log("Next steps:");
  console.log("  pnpm build");
  console.log("  pnpm pack");
  console.log("  npm publish --access public");
}
