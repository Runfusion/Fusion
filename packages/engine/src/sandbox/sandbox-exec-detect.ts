import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface SandboxExecDetectResult {
  available: boolean;
  path?: string;
  reason?: string;
}

let detectPromise: Promise<SandboxExecDetectResult> | null = null;

async function detectSandboxExecUncached(): Promise<SandboxExecDetectResult> {
  if (process.platform !== "darwin") {
    return { available: false, reason: "not-darwin" };
  }

  try {
    const { stdout } = await execAsync("command -v sandbox-exec && sandbox-exec -p '(version 1)(allow default)' /usr/bin/true", {
      timeout: 5_000,
      maxBuffer: 256 * 1024,
      encoding: "utf-8",
      shell: "/bin/bash",
    });

    const lines = (stdout ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    return {
      available: true,
      ...(lines[0] ? { path: lines[0] } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      available: false,
      reason: message.includes("not found") || message.includes("ENOENT") ? "not-installed" : message,
    };
  }
}

export async function detectSandboxExec(): Promise<SandboxExecDetectResult> {
  if (!detectPromise) {
    detectPromise = detectSandboxExecUncached();
  }
  return detectPromise;
}

export function resetSandboxExecDetectCache(): void {
  detectPromise = null;
}
