import { exec } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isVersionNewer, resolveUpdateTargetVersion } from "@fusion/core";
import type { UpdateChannel } from "@fusion/core";
import { getCachedUpdateStatus, getConfiguredUpdateChannel, persistUpdateChannel } from "../update-cache.js";

const execAsync = promisify(exec);
const REGISTRY_URL = "https://registry.npmjs.org/@runfusion%2Ffusion";
// FNXC:UpdateInstall 2026-07-19-09:50 (kept through channel merge): native npm
// dependencies can take >2min on Windows; installs get five minutes.
const INSTALL_TIMEOUT_MS = 300_000;

/*
FNXC:UpdateChannels 2026-07-19-13:00:
`fn update` is channel-aware. `stable` (default) follows the npm `latest`
dist-tag; `beta` follows the semver-max of `latest` and `beta` so beta users
also receive promoted stable releases. The install always pins the exact
resolved version (`@runfusion/fusion@X.Y.Z[-beta.N]`) — never a bare dist-tag —
so a beta-channel install can never silently land on the wrong track.
`--channel <stable|beta>` persists the choice to global settings (shared with
the dashboard and desktop updater). Switching beta → stable does not downgrade;
`--force` is the explicit escape hatch that installs the channel target even
when it is not newer than the current version.
*/
export type RunUpdateOptions = {
  check?: boolean;
  global?: boolean;
  json?: boolean;
  /** Raw --channel value; validated to "stable" | "beta". */
  channel?: string;
  /** Install the resolved channel target even when it is not newer (explicit downgrade). */
  force?: boolean;
};

type UpdateStatus = {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  updated: boolean;
  channel: UpdateChannel;
};

function readOwnCliVersion(): string | undefined {
  let currentDir: string;
  try {
    currentDir = dirname(fileURLToPath(import.meta.url));
  } catch {
    return undefined;
  }

  for (let i = 0; i < 8; i += 1) {
    const pkgPath = resolve(currentDir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const parsed = JSON.parse(readFileSync(pkgPath, "utf-8")) as { name?: string; version?: string };
        if (parsed.name === "@runfusion/fusion" && typeof parsed.version === "string") {
          return parsed.version;
        }
      } catch {
        // Ignore parse errors and keep walking.
      }
    }

    const parentDir = resolve(currentDir, "..");
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return undefined;
}

async function fetchChannelTargetVersion(channel: UpdateChannel): Promise<string> {
  const response = await fetch(REGISTRY_URL);
  const payload = (await response.json()) as {
    "dist-tags"?: {
      latest?: string;
      beta?: string;
    };
  };

  const targetVersion = resolveUpdateTargetVersion(channel, {
    latest: payload?.["dist-tags"]?.latest,
    beta: payload?.["dist-tags"]?.beta,
  });
  if (typeof targetVersion !== "string" || targetVersion.length === 0) {
    throw new Error(`Could not determine ${channel} version from npm registry response.`);
  }

  return targetVersion;
}

// FNXC:UpdateChannels 2026-07-19-16:20: the version comes from the npm
// registry's dist-tags and is interpolated into a shell-executed npm install;
// only a strict-semver-shaped string may pass (registry-poisoning hardening,
// PR #2345 review).
const SAFE_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function getInstallCommand(globalInstall: boolean, version: string, force = false): string {
  // Pin the exact resolved version so the installed build always matches the
  // selected channel (installing `@latest` would drag a beta user to stable).
  if (!SAFE_VERSION_RE.test(version)) {
    throw new Error(`Refusing to install: '${version}' is not a valid version string.`);
  }
  const spec = `@runfusion/fusion@${version}`;
  return `npm install${force ? " --force" : ""}${globalInstall ? " -g" : ""} ${spec}`;
}

type InstallError = Error & {
  stdout?: string;
  stderr?: string;
  killed?: boolean;
};

function isInstallTimeoutError(error: unknown): boolean {
  const installError = error as InstallError;
  /*
  FNXC:UpdateInstall 2026-07-19-09:50:
  Native npm dependencies can take longer than two minutes to install on Windows. Allow five minutes, and classify only an exec-killed process as that ceiling so registry ETIMEDOUT failures retain their real diagnosis.
  */
  return installError?.killed === true;
}

function installTimeoutError(globalInstall: boolean, version: string, force = false): Error {
  // Channel merge: the retry hint pins the resolved version like the install
  // itself — suggesting @latest would cross release tracks for beta users.
  const command = getInstallCommand(globalInstall, version, force);
  return new Error(
    `Update timed out after ${INSTALL_TIMEOUT_MS / 60_000} minutes. Retry from a terminal with: ${command}`,
  );
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

function detectRunningBinaryPath(): string | null {
  const argvPath = process.argv[1];
  if (typeof argvPath === "string" && argvPath.length > 0) {
    return argvPath;
  }
  return typeof process.execPath === "string" ? process.execPath : null;
}

function shouldSuggestHomebrewFix(binaryPath: string | null): boolean {
  if (!binaryPath) return false;
  return (
    binaryPath.startsWith("/opt/homebrew/") ||
    binaryPath.startsWith("/usr/local/Homebrew/") ||
    binaryPath.startsWith("/home/linuxbrew/")
  );
}

function printCollisionRemediation(binaryPath: string | null): void {
  console.error("Legacy runfusion.ai bin links blocked automatic update. Run:");
  console.error("  npm uninstall -g runfusion.ai");
  console.error("  rm -f $(command -v fn) $(command -v fusion)");
  console.error("  npm install -g @runfusion/fusion@latest");
  if (shouldSuggestHomebrewFix(binaryPath)) {
    console.error("If installed via Homebrew, reinstall with:");
    console.error("  brew uninstall fusion && brew install runfusion/tap/fusion");
  }
}

async function installVersion(globalInstall: boolean, version: string, resolveBinaryPath: () => string | null = detectRunningBinaryPath): Promise<void> {
  try {
    await execAsync(getInstallCommand(globalInstall, version), {
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    return;
  } catch (error) {
    if (isInstallTimeoutError(error)) {
      throw installTimeoutError(globalInstall, version);
    }
    if (!isBinCollisionInstallError(error)) {
      throw error;
    }

    console.error("Detected legacy runfusion.ai bin symlinks; retrying update with --force.");

    try {
      await execAsync(getInstallCommand(globalInstall, version, true), {
        timeout: INSTALL_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
      });
      return;
    } catch (forceError) {
      if (isInstallTimeoutError(forceError)) {
        throw installTimeoutError(globalInstall, version, true);
      }
      printCollisionRemediation(resolveBinaryPath());
      throw forceError;
    }
  }
}

function printStatus(status: UpdateStatus, checkOnly: boolean): void {
  console.log(`Channel: ${status.channel}`);
  console.log(`Current version: ${status.currentVersion}`);
  console.log(`Latest ${status.channel} version: ${status.latestVersion}`);

  if (!status.updateAvailable) {
    if (status.updated) {
      // --force path: installed the channel target even though it wasn't newer.
      console.log("Installed channel version (forced).");
      return;
    }
    console.log("Already up to date.");
    if (status.channel === "stable" && isVersionNewer(status.currentVersion, status.latestVersion)) {
      console.log("Current version is a beta ahead of stable. Use `fn update --force` to switch back to the stable build now, or stay until the next stable release overtakes it.");
    }
    return;
  }

  if (checkOnly) {
    console.log("Update available.");
    return;
  }

  if (status.updated) {
    console.log("Update complete.");
  }
}

function printJson(status: UpdateStatus): void {
  console.log(JSON.stringify(status));
}

function getLatestVersionFallback(currentVersion: string, channel: UpdateChannel): string | null {
  const cached = getCachedUpdateStatus(currentVersion);
  if (!cached) return null;
  // A cache written for another channel must not stand in for this one —
  // e.g. a stable cache would hide the beta a freshly-switched user asked for.
  if ((cached.channel ?? "stable") !== channel) return null;
  return cached.latestVersion;
}

export async function runUpdate(options: RunUpdateOptions = {}): Promise<void> {
  const checkOnly = options.check === true;
  const globalInstall = options.global !== false;
  const jsonOutput = options.json === true;
  const force = options.force === true;

  if (options.channel !== undefined && options.channel !== "stable" && options.channel !== "beta") {
    console.error(`Error: invalid --channel '${options.channel}'. Valid channels: stable, beta.`);
    process.exit(1);
    return;
  }

  // FNXC:UpdateChannels 2026-07-19-13:00: an explicit --channel flag is
  // persisted (even with --check) so every update surface follows the switch.
  let channel: UpdateChannel;
  if (options.channel === "stable" || options.channel === "beta") {
    channel = options.channel;
    try {
      await persistUpdateChannel(channel);
      if (!jsonOutput) {
        console.log(`Update channel set to '${channel}'.`);
      }
    } catch {
      if (!jsonOutput) {
        console.log(`Warning: could not persist update channel '${channel}'; using it for this run only.`);
      }
    }
  } else {
    channel = await getConfiguredUpdateChannel();
  }

  const currentVersion = readOwnCliVersion();
  if (!currentVersion) {
    console.error("Error: Could not determine current Fusion CLI version.");
    process.exit(1);
    return;
  }

  let latestVersion: string;
  try {
    latestVersion = await fetchChannelTargetVersion(channel);
  } catch (error) {
    const fallbackVersion = getLatestVersionFallback(currentVersion, channel);
    if (!fallbackVersion) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error checking for updates: ${message}`);
      process.exit(1);
      return;
    }

    latestVersion = fallbackVersion;
    if (!jsonOutput) {
      console.log("Warning: npm registry unreachable, using cached update metadata.");
    }
  }

  const updateAvailable = isVersionNewer(latestVersion, currentVersion);
  // --force installs the channel target even when it isn't newer — the
  // explicit beta → stable downgrade path. A same-version force is a no-op.
  const shouldInstall = updateAvailable || (force && latestVersion !== currentVersion);

  if (checkOnly) {
    const checkStatus: UpdateStatus = {
      currentVersion,
      latestVersion,
      updateAvailable,
      updated: false,
      channel,
    };

    if (jsonOutput) {
      printJson(checkStatus);
    } else {
      printStatus(checkStatus, true);
    }

    if (updateAvailable) {
      process.exitCode = 1;
    }
    return;
  }

  if (!shouldInstall) {
    const status: UpdateStatus = {
      currentVersion,
      latestVersion,
      updateAvailable: false,
      updated: false,
      channel,
    };

    if (jsonOutput) {
      printJson(status);
    } else {
      printStatus(status, false);
    }
    return;
  }

  try {
    await installVersion(globalInstall, latestVersion);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error installing update: ${message}`);
    process.exit(1);
    return;
  }

  const updatedStatus: UpdateStatus = {
    currentVersion,
    latestVersion,
    updateAvailable,
    updated: true,
    channel,
  };

  if (jsonOutput) {
    printJson(updatedStatus);
    return;
  }

  printStatus(updatedStatus, false);
}
