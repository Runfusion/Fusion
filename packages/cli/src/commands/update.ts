import { exec } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getCachedUpdateStatus } from "../update-cache.js";

const execAsync = promisify(exec);
const REGISTRY_URL = "https://registry.npmjs.org/@runfusion%2Ffusion";
const INSTALL_COMMAND = "npm install -g @runfusion/fusion@latest";
const LOCAL_INSTALL_COMMAND = "npm install @runfusion/fusion@latest";
const INSTALL_TIMEOUT_MS = 300_000;

export type RunUpdateOptions = {
  check?: boolean;
  global?: boolean;
  json?: boolean;
};

type UpdateStatus = {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  updated: boolean;
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

function parseVersion(version: string): number[] {
  return version
    .split(".")
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
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

async function fetchLatestVersion(): Promise<string> {
  const response = await fetch(REGISTRY_URL);
  const payload = (await response.json()) as {
    "dist-tags"?: {
      latest?: string;
    };
  };

  const latestVersion = payload?.["dist-tags"]?.latest;
  if (typeof latestVersion !== "string" || latestVersion.length === 0) {
    throw new Error("Could not determine latest version from npm registry response.");
  }

  return latestVersion;
}

function getInstallCommand(globalInstall: boolean, force = false): string {
  const baseCommand = globalInstall ? INSTALL_COMMAND : LOCAL_INSTALL_COMMAND;
  return force ? baseCommand.replace("npm install", "npm install --force") : baseCommand;
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

function installTimeoutError(globalInstall: boolean, force = false): Error {
  const command = getInstallCommand(globalInstall, force);
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

async function installLatest(globalInstall: boolean, resolveBinaryPath: () => string | null = detectRunningBinaryPath): Promise<void> {
  try {
    await execAsync(getInstallCommand(globalInstall), {
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    return;
  } catch (error) {
    if (isInstallTimeoutError(error)) {
      throw installTimeoutError(globalInstall);
    }
    if (!isBinCollisionInstallError(error)) {
      throw error;
    }

    console.error("Detected legacy runfusion.ai bin symlinks; retrying update with --force.");

    try {
      await execAsync(getInstallCommand(globalInstall, true), {
        timeout: INSTALL_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
      });
      return;
    } catch (forceError) {
      if (isInstallTimeoutError(forceError)) {
        throw installTimeoutError(globalInstall, true);
      }
      printCollisionRemediation(resolveBinaryPath());
      throw forceError;
    }
  }
}

function printStatus(status: UpdateStatus, checkOnly: boolean): void {
  console.log(`Current version: ${status.currentVersion}`);
  console.log(`Latest version: ${status.latestVersion}`);

  if (!status.updateAvailable) {
    console.log("Already up to date.");
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

function getLatestVersionFallback(currentVersion: string): string | null {
  const cached = getCachedUpdateStatus(currentVersion);
  if (!cached) return null;
  return cached.latestVersion;
}

export async function runUpdate(options: RunUpdateOptions = {}): Promise<void> {
  const checkOnly = options.check === true;
  const globalInstall = options.global !== false;
  const jsonOutput = options.json === true;

  const currentVersion = readOwnCliVersion();
  if (!currentVersion) {
    console.error("Error: Could not determine current Fusion CLI version.");
    process.exit(1);
    return;
  }

  let latestVersion: string;
  try {
    latestVersion = await fetchLatestVersion();
  } catch (error) {
    const fallbackVersion = getLatestVersionFallback(currentVersion);
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

  const updateAvailable = isRemoteNewer(latestVersion, currentVersion);

  if (checkOnly) {
    const checkStatus: UpdateStatus = {
      currentVersion,
      latestVersion,
      updateAvailable,
      updated: false,
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

  if (!updateAvailable) {
    const status: UpdateStatus = {
      currentVersion,
      latestVersion,
      updateAvailable: false,
      updated: false,
    };

    if (jsonOutput) {
      printJson(status);
    } else {
      printStatus(status, false);
    }
    return;
  }

  try {
    await installLatest(globalInstall);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error installing update: ${message}`);
    process.exit(1);
    return;
  }

  const updatedStatus: UpdateStatus = {
    currentVersion,
    latestVersion,
    updateAvailable: true,
    updated: true,
  };

  if (jsonOutput) {
    printJson(updatedStatus);
    return;
  }

  printStatus(updatedStatus, false);
}
