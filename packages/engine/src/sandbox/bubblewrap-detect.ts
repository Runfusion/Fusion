import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface BwrapDetectResult {
  available: boolean;
  version?: string;
  path?: string;
  reason?: string;
}

let detectPromise: Promise<BwrapDetectResult> | null = null;

function parseVersion(raw: string): string | undefined {
  const match = raw.match(/(\d+\.\d+(?:\.\d+)?)/);
  return match?.[1];
}

async function detectBwrapUncached(): Promise<BwrapDetectResult> {
  if (process.platform !== "linux") {
    return { available: false, reason: "not-linux" };
  }

  try {
    const { stdout, stderr } = await execAsync("command -v bwrap && bwrap --version", {
      timeout: 5_000,
      maxBuffer: 256 * 1024,
      encoding: "utf-8",
      shell: "/bin/bash",
    });

    const combined = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
    const lines = (stdout ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
    const path = lines[0];
    const version = parseVersion(combined);

    return {
      available: true,
      ...(version !== undefined && { version }),
      ...(path !== undefined && { path }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      available: false,
      reason: message.includes("not found") || message.includes("ENOENT") ? "not-installed" : message,
    };
  }
}

export async function detectBwrap(): Promise<BwrapDetectResult> {
  if (!detectPromise) {
    detectPromise = detectBwrapUncached();
  }
  return detectPromise;
}

export function resetBwrapDetectCache(): void {
  detectPromise = null;
}
