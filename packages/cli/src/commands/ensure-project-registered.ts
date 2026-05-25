import { exec } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import {
  type CentralCore,
  type RegisteredProject,
  type ProjectIdentity,
  readProjectIdentity,
  writeProjectIdentity,
} from "@fusion/core";

const execAsync = promisify(exec);

export interface EnsureCwdProjectRegisteredOptions {
  cwd: string;
  central: CentralCore;
  logPrefix: string;
  autoRegister: boolean;
}

function stampProjectIdentityBestEffort(
  cwd: string,
  project: RegisteredProject,
  logPrefix: string,
): void {
  try {
    writeProjectIdentity(join(cwd, ".fusion"), {
      id: project.id,
      createdAt: project.createdAt,
    });
  } catch (error) {
    console.warn(
      `[${logPrefix}] Could not persist project identity for ${cwd}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function ensureCwdProjectRegistered(
  options: EnsureCwdProjectRegisteredOptions,
): Promise<RegisteredProject | null> {
  const { cwd, central, logPrefix, autoRegister } = options;

  const existing = await central.getProjectByPath(cwd);
  if (existing) {
    stampProjectIdentityBestEffort(cwd, existing, logPrefix);
    return existing;
  }

  if (!autoRegister) {
    logManualRegistrationHint(logPrefix, cwd);
    return null;
  }

  try {
    const fusionDir = join(cwd, ".fusion");
    const dbPath = join(fusionDir, "fusion.db");

    if (!existsSync(fusionDir)) {
      mkdirSync(fusionDir, { recursive: true });
    }

    if (!existsSync(dbPath)) {
      writeFileSync(dbPath, "");
    }

    const projectName = await detectProjectName(cwd);
    const identity: ProjectIdentity | null = existsSync(dbPath) ? readProjectIdentity(fusionDir) : null;

    const ensured = await central.ensureProjectForPath({
      path: cwd,
      identity: identity ?? undefined,
      name: projectName,
    });

    const project = ensured.project;
    await central.updateProject(project.id, { status: "active" });
    stampProjectIdentityBestEffort(cwd, project, logPrefix);

    if (ensured.outcome === "reattached") {
      console.log(
        `[${logPrefix}] Recovered project identity ${project.id} from ${dbPath} (central had no row)`,
      );
    } else if (ensured.outcome === "registered") {
      console.log(`[${logPrefix}] Auto-registered project "${project.name}" at ${cwd}`);
    }

    return project;
  } catch (error) {
    console.error(
      `[${logPrefix}] Failed to auto-register current project: ${error instanceof Error ? error.message : String(error)}`,
    );
    logManualRegistrationHint(logPrefix, cwd);
    return null;
  }
}

async function detectProjectName(dir: string): Promise<string> {
  if (!existsSync(join(dir, ".git"))) {
    return basename(dir) || "my-project";
  }

  try {
    const { stdout: remoteUrl } = await execAsync("git remote get-url origin", {
      cwd: dir,
      timeout: 10_000,
    });

    const trimmed = remoteUrl.trim();
    if (trimmed) {
      const match = trimmed.match(/[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
      if (match) {
        return match[2];
      }
    }
  } catch {
    // ignore
  }

  return basename(dir) || "my-project";
}

function logManualRegistrationHint(logPrefix: string, cwd: string): void {
  console.error(`[${logPrefix}] Run 'fn init' to register this project, or 'fn project add <name> <path>' (${cwd})`);
}
