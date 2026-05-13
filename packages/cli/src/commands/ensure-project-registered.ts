import { exec } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { CentralCore, RegisteredProject } from "@fusion/core";

const execAsync = promisify(exec);

export interface EnsureCwdProjectRegisteredOptions {
  cwd: string;
  central: CentralCore;
  logPrefix: string;
  autoRegister: boolean;
}

export async function ensureCwdProjectRegistered(
  options: EnsureCwdProjectRegisteredOptions,
): Promise<RegisteredProject | null> {
  const { cwd, central, logPrefix, autoRegister } = options;

  const existing = await central.getProjectByPath(cwd);
  if (existing) {
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
    const project = await central.registerProject({
      name: projectName,
      path: cwd,
      isolationMode: "in-process",
    });

    await central.updateProject(project.id, { status: "active" });
    console.log(`[${logPrefix}] Auto-registered project "${project.name}" at ${cwd}`);

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
