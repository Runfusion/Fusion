import { superviseSpawn } from "@fusion/core";

const COMMAND_TIMEOUT_MS = 30_000;
const OUTPUT_MAX = 16_384;

/**
 * FNXC:AntigravityCliProcess 2026-09-20-19:17:
 * Provider management commands use the same supervised, shell-free boundary as
 * streamed turns. They receive only launcher-local environment values because
 * MCP management must not inherit Fusion credentials or unrelated process data.
 */
export function antigravityCliEnvironment(): NodeJS.ProcessEnv {
  const source = process.env;
  const names = process.platform === "win32"
    ? ["PATH", "SystemRoot", "ComSpec", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP"]
    : ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR"];
  return Object.fromEntries(names.flatMap((name) => source[name] === undefined ? [] : [[name, source[name]]])) as NodeJS.ProcessEnv;
}

export async function runAntigravityCliCommand(binary: string, args: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<{ code: number; stdout: string; stderr: string }> {
  const supervised = superviseSpawn(binary, args, {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: antigravityCliEnvironment(),
    maxLifetimeMs: timeoutMs,
  });
  const { child } = supervised;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr });
    };
    child.stdout?.on("data", (chunk) => { stdout = (stdout + String(chunk)).slice(-OUTPUT_MAX); });
    child.stderr?.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-OUTPUT_MAX); });
    child.once("error", () => finish(127));
    child.once("close", (code) => finish(code ?? 1));
  });
}
