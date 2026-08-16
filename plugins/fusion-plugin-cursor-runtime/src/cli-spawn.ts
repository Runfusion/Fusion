import { spawn, spawnSync } from "node:child_process";
import path, { sep as PATH_SEP } from "node:path";

function formatSpawnError(error: Error & { code?: unknown }): string {
  const code = typeof error.code === "string" ? `${error.code}: ` : "";
  return `spawn error: ${code}${error.message}`.trim();
}

export async function runCursorCommand(binary: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (result: { code: number | null; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    /*
    FNXC:CursorCli 2026-07-02-00:00:
    Windows Cursor installers and npm-style shims can expose `cursor-agent.cmd` or `cursor.cmd` on PATH, and Node cannot direct-spawn those batch wrappers without the command shell.
    Keep Unix/macOS on direct spawn so only the known Cursor CLI probe/discovery seam uses shell resolution where Windows requires it.
    Streaming prompt execution deliberately diverges; see prompt-transport.ts for its supervised shell:false launch contract.
    */
    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {
        // best effort
      }
      finish({ code: 124, stdout, stderr });
    }, timeoutMs);

    child.stdout?.on("data", (c: Buffer) => { stdout += c.toString("utf-8"); });
    child.stderr?.on("data", (c: Buffer) => { stderr += c.toString("utf-8"); });
    child.once("error", (error: Error & { code?: unknown }) => {
      const diagnostic = formatSpawnError(error);
      stderr = stderr ? `${stderr}\n${diagnostic}` : diagnostic;
      finish({ code: 127, stdout, stderr });
    });
    child.once("close", (code) => {
      finish({ code, stdout, stderr });
    });
  });
}

const resolvedSpawnBinaries = new Map<string, string>();

/** Resolve only the first where.exe directory; later PATH entries are different programs. */
export function resolveCursorBinaryForSpawn(binary: string): string {
  if (process.platform !== "win32") return binary;
  if (binary.includes(PATH_SEP) || binary.includes("/") || /\.[^.\\/]+$/i.test(binary)) return binary;
  const cached = resolvedSpawnBinaries.get(binary);
  if (cached) return cached;
  let result: ReturnType<typeof spawnSync>;
  try { result = spawnSync("where.exe", [binary], { encoding: "utf-8", windowsHide: true, shell: false, timeout: 2_000 }); } catch { return binary; }
  const lines = String(result.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return binary;
  const first = lines[0];
  const firstDirectory = path.dirname(first).toLowerCase();
  const extensions = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").map((extension) => extension.toLowerCase());
  const candidate = extensions.map((extension) => lines.find((line) => path.dirname(line).toLowerCase() === firstDirectory && path.extname(line).toLowerCase() === extension)).find(Boolean) ?? first;
  resolvedSpawnBinaries.set(binary, candidate);
  return candidate;
}

export type WindowsLaunchTarget = "direct" | "cmd-shim" | "powershell-shim" | "unsupported";
export function classifyWindowsLaunchTarget(target: string): WindowsLaunchTarget {
  const extension = path.extname(target).toLowerCase();
  if (!extension || extension === ".exe" || extension === ".com") return "direct";
  if (extension === ".cmd" || extension === ".bat") return "cmd-shim";
  if (extension === ".ps1") return "powershell-shim";
  return "unsupported";
}

// FNXC:CursorCli 2026-08-15-15:32: Bracketed Cursor model parameters are data, not cmd control syntax; reject only characters cmd.exe can interpret at this boundary.
const CMD_UNSAFE = /["%!^&|<>()\r\n\0]/;
export function assertCmdBoundarySafe(token: string): void {
  const offending = token.match(CMD_UNSAFE)?.[0];
  if (offending) throw new Error(`Cursor cmd boundary rejected token ${JSON.stringify(token)} containing ${JSON.stringify(offending)}; relocate the worktree or use a direct cursor-agent executable.`);
}
export function quoteCmdArgument(value: string): string { assertCmdBoundarySafe(value); return `"${value}"`; }

/** Prefer PowerShell 7 only when it is actually resolvable; Windows PowerShell remains the installer-compatible fallback. */
export function resolvePowerShellExecutable(): string {
  try {
    const result = spawnSync("where.exe", ["pwsh.exe"], {
      encoding: "utf-8",
      windowsHide: true,
      shell: false,
      timeout: 2_000,
    });
    if (result.status === 0 && String(result.stdout ?? "").split(/\r?\n/).some((line) => line.trim())) return "pwsh.exe";
  } catch {
    // Fall through to the Windows PowerShell executable supplied on standard Windows installs.
  }
  return "powershell.exe";
}
