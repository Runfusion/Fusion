#!/usr/bin/env node
/*
FNXC:DependencyPinning 2026-07-17-12:00:
FN-8201 / Runfusion/Fusion#2270 requires the pi-ai and pi-coding-agent runtime
set to remain version-locked. npm global installs ignore pnpm-lock.yaml and can
independently resolve ranges to incompatible pi-mono patches, so every guarded
manifest declaration must be an exact semver and all declarations must agree.
*/
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PI_DEPENDENCIES = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
];

export const GUARDED_MANIFESTS = [
  "packages/cli/package.json",
  "packages/core/package.json",
  "packages/engine/package.json",
  "packages/dashboard/package.json",
  "packages/pi-claude-cli/package.json",
];

const DEPENDENCY_BLOCKS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function isExactSemver(version) {
  return typeof version === "string" && EXACT_SEMVER.test(version);
}

function listTrackedManifests() {
  const result = spawnSync("git", ["ls-files", "--", ...GUARDED_MANIFESTS], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || "git ls-files failed");
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function validateManifestSet(manifests) {
  const violations = [];
  const declaredVersions = new Map();

  for (const { filePath, manifest } of manifests) {
    for (const blockName of DEPENDENCY_BLOCKS) {
      const dependencies = manifest?.[blockName];
      if (!dependencies || typeof dependencies !== "object") continue;

      for (const packageName of PI_DEPENDENCIES) {
        if (!(packageName in dependencies)) continue;
        const version = dependencies[packageName];
        if (!isExactSemver(version)) {
          violations.push(`${filePath}: ${blockName}.${packageName} must be an exact semver, found ${JSON.stringify(version)}`);
          continue;
        }
        const declarations = declaredVersions.get(packageName) ?? [];
        declarations.push({ filePath, blockName, version });
        declaredVersions.set(packageName, declarations);
      }
    }
  }

  for (const packageName of PI_DEPENDENCIES) {
    const declarations = declaredVersions.get(packageName) ?? [];
    const versions = [...new Set(declarations.map(({ version }) => version))];
    if (versions.length > 1) {
      violations.push(`${packageName} must use one exact version across guarded manifests; found ${versions.join(", ")} (${declarations.map(({ filePath, blockName, version }) => `${filePath}:${blockName}=${version}`).join(", ")})`);
    }
  }

  const allVersions = [...new Set(
    PI_DEPENDENCIES.flatMap((packageName) =>
      (declaredVersions.get(packageName) ?? []).map(({ version }) => version),
    ),
  )];
  if (allVersions.length > 1) {
    violations.push(`${PI_DEPENDENCIES.join(" and ")} must resolve to the same exact version; found ${allVersions.join(", ")}`);
  }

  return violations;
}

export function scanTrackedManifests(files = listTrackedManifests(), options = {}) {
  const readFile = options.readFile ?? readFileSync;
  const manifests = [];
  for (const filePath of files) {
    let source;
    try {
      source = readFile(filePath, "utf8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    try {
      manifests.push({ filePath, manifest: JSON.parse(source) });
    } catch (error) {
      return [`${filePath}: invalid JSON (${error instanceof Error ? error.message : String(error)})`];
    }
  }
  return validateManifestSet(manifests);
}

export function formatFailureMessage(violations) {
  return [
    "[check-pi-versions-pinned] pi runtime dependencies must be exact, matched versions.",
    "npm global installs do not use pnpm-lock.yaml; ranges can resolve an incompatible pi-mono patch set.",
    ...violations.map((violation) => `- ${violation}`),
  ].join("\n");
}

export function main() {
  const violations = scanTrackedManifests();
  if (!violations.length) return 0;
  console.error(formatFailureMessage(violations));
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main();
