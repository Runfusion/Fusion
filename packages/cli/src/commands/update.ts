import { exec } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getCachedUpdateStatus } from "../update-cache.js";

const execAsync = promisify(exec);
const REGISTRY_URL = "https://registry.npmjs.org/@runfusion%2Ffusion";
const INSTALL_COMMAND = "npm install -g @runfusion/fusion@latest";

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

async function installLatest(globalInstall: boolean): Promise<void> {
  const command = globalInstall ? INSTALL_COMMAND : "npm install @runfusion/fusion@latest";
  await execAsync(command, {
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
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
