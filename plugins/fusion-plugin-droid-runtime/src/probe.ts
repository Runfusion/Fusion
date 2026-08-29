import { spawn } from "node:child_process";

export interface DroidBinaryStatus {
  available: boolean;
  authenticated?: boolean;
  binaryPath?: string;
  version?: string;
  reason?: string;
  probeDurationMs: number;
}

export function resolveDroidBinaryPath(settings?: Record<string, unknown>): string {
  if (typeof settings?.droidBinaryPath === "string" && settings.droidBinaryPath.trim().length > 0) {
    return settings.droidBinaryPath.trim();
  }
  return "droid";
}

async function run(binary: string, args: string[], timeoutMs = 2000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({ code: 127, stdout, stderr });
      return;
    }

    /*
    FNXC:CliRuntime 2026-06-21-12:00:
    Droid binary probes run on dashboard and engine startup status paths, so they must never reject or wait forever. Convert synchronous spawn guards, ENOENT, and timeout hangs into sentinel exit codes so boot degrades provider availability instead of blocking on a broken local `droid` install.
    */
    let settled = false;
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {
        // ignore kill errors
      }
      settle(124);
    }, timeoutMs);
    child.stdout?.on("data", (c: Buffer) => { stdout += c.toString("utf-8"); });
    child.stderr?.on("data", (c: Buffer) => { stderr += c.toString("utf-8"); });
    child.on("error", () => settle(127));
    child.on("close", (code) => settle(code));
  });
}

export async function probeDroidBinary(options?: { binaryPath?: string; settings?: Record<string, unknown>; timeoutMs?: number }): Promise<DroidBinaryStatus> {
  const startedAt = Date.now();
  const binaryPath = options?.binaryPath?.trim() || resolveDroidBinaryPath(options?.settings);
  const timeoutMs = options?.timeoutMs ?? 2000;

  const versionRun = await run(binaryPath, ["--version"], timeoutMs);
  if (versionRun.code !== 0) {
    return {
      available: false,
      binaryPath,
      reason:
        versionRun.code === 124
          ? `Probe timed out after ${timeoutMs}ms`
          : `Binary not found or not executable: ${binaryPath}`,
      probeDurationMs: Date.now() - startedAt,
    };
  }

  return {
    available: true,
    binaryPath,
    version: versionRun.stdout.trim() || undefined,
    probeDurationMs: Date.now() - startedAt,
  };
}
