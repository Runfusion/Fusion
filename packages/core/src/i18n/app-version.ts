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

/*
FNXC:UpdateChannels 2026-07-19-12:30:
Fusion ships two release tracks: `stable` (npm dist-tag `latest`) and `beta`
(npm dist-tag `beta`, versions `X.Y.Z-beta.N` cut from `main`). All update
surfaces (CLI `fn update`, dashboard update check, desktop electron-updater)
share the helpers below so channel resolution and version ordering behave
identically everywhere. The previous per-surface `isRemoteNewer` compared only
major.minor.patch and treated `0.73.0-beta.2`, `-beta.3`, and `0.73.0` as
equal, which breaks the moment any prerelease exists — these helpers implement
full SemVer 2.0.0 precedence including prerelease identifiers.
*/

/** Release track a Fusion install follows for updates. */
export type UpdateChannel = "stable" | "beta";

/** npm dist-tags relevant to update resolution. */
export type UpdateDistTags = {
  latest?: string | null;
  beta?: string | null;
};

function parseVersionParts(version: string): {
  release: number[];
  prerelease: (string | number)[] | null;
} | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  const prerelease = match[4]
    ? match[4].split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id))
    : null;
  return {
    release: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease,
  };
}

/**
 * Full SemVer 2.0.0 precedence compare (build metadata ignored).
 * Returns negative when `a < b`, 0 when equal, positive when `a > b`.
 * Unparseable versions sort below every parseable one so a malformed remote
 * value can never be offered as an "update".
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersionParts(a);
  const pb = parseVersionParts(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;

  for (let i = 0; i < 3; i += 1) {
    if (pa.release[i] !== pb.release[i]) return pa.release[i] - pb.release[i];
  }

  // SemVer: a version WITH a prerelease has lower precedence than the same
  // release without one (0.73.0-beta.1 < 0.73.0).
  if (pa.prerelease === null && pb.prerelease === null) return 0;
  if (pa.prerelease === null) return 1;
  if (pb.prerelease === null) return -1;

  const len = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i += 1) {
    const ia = pa.prerelease[i];
    const ib = pb.prerelease[i];
    // A larger identifier set has higher precedence (beta.1.2 > beta.1).
    if (ia === undefined) return -1;
    if (ib === undefined) return 1;
    if (typeof ia === "number" && typeof ib === "number") {
      if (ia !== ib) return ia - ib;
    } else if (typeof ia === "number") {
      return -1; // Numeric identifiers sort below alphanumeric ones.
    } else if (typeof ib === "number") {
      return 1;
    } else if (ia !== ib) {
      return ia < ib ? -1 : 1;
    }
  }
  return 0;
}

/** True when `remote` has strictly higher SemVer precedence than `current`. */
export function isVersionNewer(remote: string, current: string): boolean {
  return compareVersions(remote, current) > 0;
}

/**
 * Resolve the version a given update channel should offer.
 * - `stable` follows the `latest` dist-tag only — betas are invisible.
 * - `beta` follows the semver-max of `latest` and `beta`, so beta users are
 *   offered a newly promoted stable once it overtakes their prerelease.
 * Returns null when the channel has no resolvable target.
 */
export function resolveUpdateTargetVersion(
  channel: UpdateChannel | undefined,
  distTags: UpdateDistTags,
): string | null {
  const latest = typeof distTags.latest === "string" && distTags.latest.length > 0 ? distTags.latest : null;
  if (channel !== "beta") return latest;
  const beta = typeof distTags.beta === "string" && distTags.beta.length > 0 ? distTags.beta : null;
  if (latest && beta) return compareVersions(beta, latest) > 0 ? beta : latest;
  return beta ?? latest;
}
