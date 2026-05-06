import { spawn } from "node:child_process";

export interface AgentBrowserProbeResult {
  available: boolean;
  binaryPath?: string;
  version?: string;
  reason?: string;
  notFound?: boolean;
}

export async function probeAgentBrowserBinary(opts?: { binaryPath?: string; timeoutMs?: number }): Promise<AgentBrowserProbeResult> {
  const binary = opts?.binaryPath?.trim() || "agent-browser";
  const timeoutMs = opts?.timeoutMs ?? 2000;
  const resolvedPath = await tryResolveBinaryPath(binary);

  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(resolvedPath ?? binary, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ available: false, binaryPath: resolvedPath, reason: `Probe timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout?.on("data", (c: Buffer) => (stdout += c.toString("utf-8")));
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf-8")));
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        available: false,
        binaryPath: resolvedPath,
        reason: err.code === "ENOENT" ? "`agent-browser` not found on PATH" : err.message,
        notFound: err.code === "ENOENT",
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ available: true, binaryPath: resolvedPath, version: stdout.trim() || undefined });
      } else {
        resolve({
          available: false,
          binaryPath: resolvedPath,
          reason: stderr.trim() || `agent-browser --version exited with code ${String(code)}`,
        });
      }
    });
  });
}

async function tryResolveBinaryPath(binary: string): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    const which = process.platform === "win32" ? "where" : "which";
    const child = spawn(which, [binary], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignored
      }
      resolvePromise(undefined);
    }, 2000);

    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf-8");
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(undefined);
    });
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        const first = out.trim().split(/\r?\n/)[0];
        resolvePromise(first?.length ? first : undefined);
      } else {
        resolvePromise(undefined);
      }
    });
  });
}
