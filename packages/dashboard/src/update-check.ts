import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CACHE_FILENAME = "update-check.json";
const REGISTRY_URL = "https://registry.npmjs.org/@runfusion%2Ffusion";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Allowed update-check cadences from GlobalSettings. */
export type UpdateCheckFrequency = "manual" | "on-startup" | "daily" | "weekly";

export type UpdateCheckResult = {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  lastChecked: number;
  error?: string;
};

/**
 * Cache TTL in ms for the given frequency. Frequencies that don't expire by
 * elapsed time (`manual`, `on-startup`) return Infinity — those modes rely on
 * external triggers (the `/refresh` endpoint or a server-startup hook).
 */
export function ttlForFrequency(frequency: UpdateCheckFrequency | undefined): number {
  switch (frequency) {
    case "manual":
    case "on-startup":
      return Number.POSITIVE_INFINITY;
    case "weekly":
      return 7 * DAY_MS;
    case "daily":
    default:
      return DAY_MS;
  }
}

function getCachePath(fusionDir: string): string {
  return join(fusionDir, CACHE_FILENAME);
}

function parseVersion(version: string): number[] {
  return version
    .split(".")
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10))
    .map((value) => (Number.isFinite(value) ? value : 0));
}

function isRemoteNewer(remoteVersion: string, currentVersion: string): boolean {
  const remote = parseVersion(remoteVersion);
  const current = parseVersion(currentVersion);
  const maxLength = Math.max(remote.length, current.length, 3);

  for (let i = 0; i < maxLength; i += 1) {
    const remotePart = remote[i] ?? 0;
    const currentPart = current[i] ?? 0;
    if (remotePart > currentPart) return true;
    if (remotePart < currentPart) return false;
  }

  return false;
}

function isValidResult(value: unknown): value is UpdateCheckResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.currentVersion === "string" &&
    (typeof candidate.latestVersion === "string" || candidate.latestVersion === null) &&
    typeof candidate.updateAvailable === "boolean" &&
    typeof candidate.lastChecked === "number" &&
    (candidate.error === undefined || typeof candidate.error === "string")
  );
}

/**
 * Tracks whether we've refreshed the cache during the current process
 * lifetime. Used to implement `on-startup` frequency: the first /update-check
 * after server boot bypasses the cache; subsequent calls within the same
 * process return whatever was just written.
 */
let hasRefreshedThisProcess = false;

/** Test-only hook to reset the per-process startup flag. */
export function __resetStartupRefreshFlag(): void {
  hasRefreshedThisProcess = false;
}

export function readCachedUpdateCheck(fusionDir: string): UpdateCheckResult | null {
  try {
    const raw = readFileSync(getCachePath(fusionDir), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return isValidResult(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function clearUpdateCheckCache(fusionDir: string): Promise<void> {
  await rm(getCachePath(fusionDir), { force: true });
}

export async function performUpdateCheck(
  fusionDir: string,
  currentVersion: string,
  options: { frequency?: UpdateCheckFrequency; force?: boolean } = {},
): Promise<UpdateCheckResult> {
  const now = Date.now();
  const cached = readCachedUpdateCheck(fusionDir);
  const ttl = ttlForFrequency(options.frequency);
  const cacheStillFresh = cached && now - cached.lastChecked < ttl;

  // `on-startup`: refresh exactly once per process lifetime; afterwards
  // serve the freshly-written cache for the rest of the run.
  if (
    !options.force &&
    options.frequency === "on-startup" &&
    hasRefreshedThisProcess &&
    cached
  ) {
    return cached;
  }

  if (!options.force && options.frequency !== "on-startup" && cacheStillFresh) {
    return cached;
  }

  // For `manual`, never go to the network on a regular check — only the
  // `/update-check/refresh` endpoint (which sets `force: true`) should.
  // Return whatever's in the cache so the UI can still display the last
  // known result; if there's nothing cached, return a no-op disabled-style
  // payload.
  if (!options.force && options.frequency === "manual") {
    return (
      cached ?? {
        currentVersion,
        latestVersion: null,
        updateAvailable: false,
        lastChecked: now,
      }
    );
  }

  try {
    const response = await fetch(REGISTRY_URL);
    const payload = (await response.json()) as {
      "dist-tags"?: {
        latest?: string;
      };
    };

    const latestVersion = typeof payload?.["dist-tags"]?.latest === "string" ? payload["dist-tags"].latest : null;
    const updateAvailable = latestVersion ? isRemoteNewer(latestVersion, currentVersion) : false;

    const result: UpdateCheckResult = {
      currentVersion,
      latestVersion,
      updateAvailable,
      lastChecked: now,
    };

    await mkdir(fusionDir, { recursive: true });
    await writeFile(getCachePath(fusionDir), JSON.stringify(result, null, 2), "utf-8");

    hasRefreshedThisProcess = true;
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      lastChecked: now,
      error: message,
    };
  }
}
