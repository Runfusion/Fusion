import { exec } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveGlobalDir } from "@fusion/core";

const CACHE_FILENAME = "update-check.json";
const REGISTRY_URL = "https://registry.npmjs.org/@runfusion%2Ffusion";
const INSTALL_COMMAND = "npm install -g @runfusion/fusion@latest";
const FORCE_INSTALL_COMMAND = "npm install --force -g @runfusion/fusion@latest";
const INSTALL_TIMEOUT_MS = 120_000;
const INSTALL_MAX_BUFFER = 10 * 1024 * 1024;

const DAY_MS = 24 * 60 * 60 * 1000;
const execAsync = promisify(exec);
const UNRESOLVED_VERSION = "0.0.0";

/** Allowed update-check cadences from GlobalSettings. */
export type UpdateCheckFrequency = "manual" | "on-startup" | "daily" | "weekly";

export type UpdateCheckResult = {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  lastChecked: number;
  error?: string;
};

export type UpdateInstallResult = {
  currentVersion: string;
  latestVersion: string | null;
  updated: boolean;
  error?: string;
};

type ExecInstall = (
  command: string,
  options: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

type InstallError = Error & { stdout?: string; stderr?: string };

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

function isBinCollisionInstallError(error: unknown): boolean {
  const installError = error as InstallError;
  const message = [installError?.message, installError?.stderr, installError?.stdout]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n");

  const hasBinHint = /\/(fn|fusion)\b|runfusion\.ai/i.test(message);
  if (!hasBinHint) return false;

  return /EEXIST|ENOENT|File exists/i.test(message);
}

function getInstallErrorMessage(error: unknown): string {
  const installError = error as InstallError;
  const stderr = typeof installError?.stderr === "string" ? installError.stderr.trim() : "";
  if (stderr.length > 0) return stderr;
  return error instanceof Error ? error.message : String(error);
}

/*
FNXC:UpdateInstallPermissions 2026-07-10-14:00:
The in-app "Update now" button runs `npm install -g @runfusion/fusion@latest` as the
(typically non-root) dashboard process. When Fusion was installed via `sudo npm i -g`,
the global package dir is root-owned, so npm's rename() fails with EACCES/EPERM and the
button ALWAYS fails. Previously the raw npm stderr was surfaced with no explanation.
Detect the permission class and return an actionable remediation instead of a cryptic
EACCES, mirroring the CLI's Homebrew-path awareness. (`--force` cannot grant write
permission, so we do not retry it for this class — unlike bin-collision errors.)
*/
function isPermissionInstallError(error: unknown): boolean {
  const installError = error as InstallError & { code?: string };
  if (installError?.code === "EACCES" || installError?.code === "EPERM") return true;
  const message = [installError?.message, installError?.stderr, installError?.stdout]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n");
  return /\bEACCES\b|\bEPERM\b|permission denied|operation not permitted/i.test(message);
}

/** Best-effort path of the running Fusion binary, used to tailor remediation. */
function detectRunningBinaryPath(): string | null {
  const argvPath = process.argv[1];
  if (typeof argvPath === "string" && argvPath.length > 0) return argvPath;
  return typeof process.execPath === "string" ? process.execPath : null;
}

/*
FNXC:UpdateInstallPermissions 2026-07-10-16:00:
Detect a Homebrew-managed install so the remediation says `brew upgrade` rather than
the npm/sudo guidance. Formulae live under a Cellar and are symlinked into bin — on
Apple Silicon everything is under `/opt/homebrew/`, but on Intel macOS the bin symlink
is `/usr/local/bin/fn` -> `/usr/local/Cellar/...` (and `/usr/local/Homebrew/` is only
brew's own git repo, not where formulae install). So resolve the symlink and match the
real Cellar/opt install roots — checking only `/usr/local/Homebrew/` missed Intel Macs.
`/usr/local/bin` is deliberately NOT matched: it is shared with npm-global bins.
*/
function isHomebrewInstall(binaryPath: string | null): boolean {
  if (!binaryPath) return false;
  let resolved = binaryPath;
  try {
    resolved = realpathSync(binaryPath);
  } catch {
    // Unresolvable symlink/path — fall back to the raw path.
  }
  return [binaryPath, resolved].some((p) =>
    p.startsWith("/opt/homebrew/") ||     // Apple Silicon (bin, opt, Cellar)
    p.startsWith("/usr/local/Cellar/") || // Intel formula install root
    p.startsWith("/usr/local/opt/") ||    // Intel formula opt symlinks
    p.includes("/Homebrew/") ||           // brew's own repo checkout
    p.startsWith("/home/linuxbrew/"),     // Linuxbrew
  );
}

function getPermissionRemediationMessage(binaryPath: string | null): string {
  if (isHomebrewInstall(binaryPath)) {
    return (
      "Update failed: this Fusion install is managed by Homebrew and cannot be updated with npm. " +
      "Update it from a terminal with: brew upgrade fusion"
    );
  }
  return (
    "Update failed: the global npm directory is not writable by the Fusion process (EACCES/EPERM). " +
    "This happens when Fusion was installed with `sudo npm i -g`, leaving a root-owned package directory " +
    "that the dashboard (running as a normal user) cannot replace. Update from a terminal instead:\n" +
    "  • sudo fn update  (or: sudo npm i -g @runfusion/fusion@latest)\n" +
    "  • or reinstall without sudo so the global directory is user-owned"
  );
}

function getInstallOptions(): { timeout: number; maxBuffer: number } {
  return {
    timeout: INSTALL_TIMEOUT_MS,
    maxBuffer: INSTALL_MAX_BUFFER,
  };
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

export async function performUpdateInstall(
  currentVersion: string,
  latestVersion: string | null,
  options: { exec?: ExecInstall; fusionDir?: string } = {},
): Promise<UpdateInstallResult> {
  const runExec = options.exec ?? execAsync;
  const fusionDir = options.fusionDir ?? resolveGlobalDir();

  try {
    await runExec(INSTALL_COMMAND, getInstallOptions());
    await clearUpdateCheckCache(fusionDir);
    return {
      currentVersion,
      latestVersion,
      updated: true,
    };
  } catch (error) {
    // FNXC:UpdateInstallPermissions 2026-07-10-14:00: a root-owned global dir
    // (from `sudo npm i -g`) yields EACCES/EPERM the non-root updater cannot
    // recover from — return actionable guidance rather than raw npm stderr.
    if (isPermissionInstallError(error)) {
      return {
        currentVersion,
        latestVersion,
        updated: false,
        error: getPermissionRemediationMessage(detectRunningBinaryPath()),
      };
    }

    if (!isBinCollisionInstallError(error)) {
      return {
        currentVersion,
        latestVersion,
        updated: false,
        error: getInstallErrorMessage(error),
      };
    }

    try {
      await runExec(FORCE_INSTALL_COMMAND, getInstallOptions());
      await clearUpdateCheckCache(fusionDir);
      return {
        currentVersion,
        latestVersion,
        updated: true,
      };
    } catch (forceError) {
      return {
        currentVersion,
        latestVersion,
        updated: false,
        error: getInstallErrorMessage(forceError),
      };
    }
  }
}

export async function performUpdateCheck(
  fusionDir: string,
  currentVersion: string,
  options: { frequency?: UpdateCheckFrequency; force?: boolean } = {},
): Promise<UpdateCheckResult> {
  const now = Date.now();

  /*
   * FNXC:DesktopUpdates 2026-07-03-15:35:
   * `0.0.0` is a resolver sentinel, not an installed Fusion version. If packaged/runtime metadata is missing, update surfaces must fail closed instead of comparing npm's latest release against zero and showing a false-positive desktop update banner.
   */
  if (currentVersion === UNRESOLVED_VERSION) {
    return {
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      lastChecked: now,
      error: "Current Fusion version is unavailable",
    };
  }
  const cached = readCachedUpdateCheck(fusionDir);
  const cacheMatchesCurrentVersion = !cached || cached.currentVersion === currentVersion;
  const ttl = ttlForFrequency(options.frequency);
  const cacheStillFresh = cached && cacheMatchesCurrentVersion && now - cached.lastChecked < ttl;

  // `on-startup`: refresh exactly once per process lifetime; afterwards
  // serve the freshly-written cache for the rest of the run.
  if (
    !options.force &&
    options.frequency === "on-startup" &&
    hasRefreshedThisProcess &&
    cached &&
    cacheMatchesCurrentVersion
  ) {
    return cached;
  }

  if (!options.force && options.frequency !== "on-startup" && cacheStillFresh) {
    return cached;
  }

  // For `manual`, never go to the network on a regular check — only the
  // `/update-check/refresh` endpoint (which sets `force: true`) should.
  // Return whatever's in the cache so the UI can still display the last
  // known result, but only when it matches the currently installed version.
  // After an upgrade, the old cache would otherwise keep showing a stale
  // "current version" until the next manual refresh.
  if (!options.force && options.frequency === "manual") {
    return (
      (cacheMatchesCurrentVersion ? cached : null) ?? {
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
