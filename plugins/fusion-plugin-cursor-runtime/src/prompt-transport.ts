import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { superviseSpawn, type SupervisedChild } from "@fusion/core";
import { assertCmdBoundarySafe, classifyWindowsLaunchTarget, quoteCmdArgument, resolveCursorBinaryForSpawn, resolvePowerShellExecutable } from "./cli-spawn.js";
import { parseCursorStreamLine } from "./stream-parser.js";

const FIRST_LINE_DEFAULT_MS = 30_000;
const INACTIVITY_DEFAULT_MS = 120_000;
const STDERR_MAX = 16_384;
function timeout(name: string, fallback: number) { const value = Number(process.env[name]); return Number.isFinite(value) && value > 0 ? value : fallback; }

export interface CursorPromptCallbacks { onText?: (text: string) => void; onThinking?: (text: string) => void; onToolStart?: (name: string, args?: Record<string, unknown>) => void; onToolEnd?: (name: string, isError: boolean, result?: unknown) => void; }
export interface CursorPromptInput extends CursorPromptCallbacks { binary?: string; model?: string; cwd: string; tools?: "coding" | "readonly"; prompt: string; resumeId?: string; signal?: AbortSignal; workspaceFlagRequired?: boolean; approveMcps?: boolean; }
export interface CursorPromptResult { sessionId?: string; text: string; usage?: unknown; }
export interface CursorPromptDependencies { supervise?: typeof superviseSpawn; taskkill?: typeof spawn; platform?: NodeJS.Platform; resolvePowerShell?: () => string; }

/*
FNXC:CursorCli 2026-08-15-15:16:
Streaming Cursor turns are supervised rather than using the probe's shell runner. The prompt stays
on stdin; direct targets eliminate cmd, while cmd shims reject unsafe tokens before verbatim quoting.
This preserves task-worktree autonomy and prevents a long-running agent from outliving Fusion.
*/
export async function launchCursorPrompt(input: CursorPromptInput, deps: CursorPromptDependencies = {}): Promise<CursorPromptResult> {
  if (!input.cwd || !existsSync(input.cwd)) throw new Error(`Cursor CLI requires an existing session cwd: ${input.cwd || "(missing)"}`);
  const platform = deps.platform ?? process.platform;
  const configuredBinary = input.binary?.trim();
  const target = resolveCursorBinaryForSpawn(configuredBinary || "cursor-agent");
  const fallbackBinary = configuredBinary ? undefined : target === "cursor-agent" ? "cursor" : undefined;
  const model = (input.model || "auto").replace(/^cursor-cli\//, "");
  const args = ["--print", "--output-format", "stream-json", "--model", model, "--trust"];
  if (input.workspaceFlagRequired) args.push("--workspace", input.cwd);
  if (input.tools === "coding") args.push("--force"); else args.push("--mode", "plan");
  // FNXC:CursorMcpBridge 2026-08-15-21:20: Cursor approves MCP calls only when a lease was safely staged for this turn; failed staging must remain a tool-less turn.
  if (input.approveMcps) args.push("--approve-mcps");
  if (input.resumeId) args.push("--resume", input.resumeId);
  /*
  FNXC:CursorCli 2026-08-15-15:47:
  A Cursor turn is bounded by first output and reset-on-output inactivity, not a total duration.
  Active coding turns may legitimately stream beyond two minutes, so disable the supervisor lifetime cap while retaining parent-shutdown supervision and explicit teardown.
  */
  const options = { shell: false as const, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"], cwd: input.cwd, maxLifetimeMs: Number.POSITIVE_INFINITY };
  const supervise = deps.supervise ?? superviseSpawn;
  let command = target; let launchArgs = args; let launchOptions: Parameters<typeof superviseSpawn>[2] = options;
  if (platform === "win32") {
    const classification = classifyWindowsLaunchTarget(target);
    if (classification === "unsupported") throw new Error(`Cursor CLI resolved target ${target} has unsupported ${path.extname(target)} extension; point cursorCliBinaryPath at the cursor-agent executable.`);
    if (classification === "cmd-shim") {
      [target, ...args].forEach(assertCmdBoundarySafe);
      const commandLine = [quoteCmdArgument(target), ...args.map(quoteCmdArgument)].join(" ");
      const configured = process.env.ComSpec;
      const comspec = configured && path.isAbsolute(configured) && path.basename(configured).toLowerCase() === "cmd.exe" && !configured.includes('"') ? configured : "cmd.exe";
      if (comspec.length + commandLine.length > 8000) throw new Error(`Cursor cmd command line length ${comspec.length + commandLine.length} exceeds 8000 characters for ${target}.`);
      command = comspec; launchArgs = ["/d", "/s", "/c", `"${commandLine}"`]; launchOptions = { ...options, windowsVerbatimArguments: true };
    } else if (classification === "powershell-shim") {
      // FNXC:CursorCli 2026-08-15-15:32: Cursor's Windows installer can leave only Windows PowerShell available, so prefer pwsh only after resolution and retain powershell.exe fallback.
      command = (deps.resolvePowerShell ?? resolvePowerShellExecutable)();
      launchArgs = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", target, ...args];
    }
  }
  let supervised: SupervisedChild;
  try {
    supervised = supervise(command, launchArgs, launchOptions);
  } catch (error) {
    if (fallbackBinary && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return launchCursorPrompt({ ...input, binary: fallbackBinary }, deps);
    }
    throw new Error(`Cursor CLI spawn failed for ${target} (${platform === "win32" ? classifyWindowsLaunchTarget(target) : "direct"}): ${error instanceof Error ? error.message : String(error)}`);
  }
  const child = supervised.child;
  let settled = false, sawResult = false, output = "", sessionId: string | undefined, usage: unknown, stderr = "", teardownReason: string | undefined;
  let firstTimer: NodeJS.Timeout | undefined; let inactivityTimer: NodeJS.Timeout | undefined;
  const teardown = (reason: string) => {
    if (teardownReason || child.exitCode !== null || child.signalCode !== null) return;
    teardownReason = reason;
    if (platform === "win32" && typeof supervised.pid === "number") {
      try {
        (deps.taskkill ?? spawn)("taskkill", ["/pid", String(supervised.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => undefined);
      } catch {
        // FNXC:CursorCli 2026-08-15-15:16: taskkill can be absent; supervisor teardown still reaps the launcher.
      }
      supervised.kill();
    } else supervised.kill("SIGKILL");
  };
  return new Promise<CursorPromptResult>((resolve, reject) => {
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (firstTimer) clearTimeout(firstTimer);
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (input.signal) input.signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve({ sessionId, text: output, usage });
    };
    const retryWithFallback = (error: NodeJS.ErrnoException): boolean => {
      if (!fallbackBinary || error.code !== "ENOENT" || settled) return false;
      settled = true;
      if (firstTimer) clearTimeout(firstTimer);
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (input.signal) input.signal.removeEventListener("abort", abort);
      /*
      FNXC:CursorCli 2026-08-15-15:47:
      Probe and execution share the cursor-agent → cursor PATH contract. Retry only an absent default launcher; an explicit operator binary remains authoritative and non-ENOENT launch failures must surface unchanged.
      */
      void launchCursorPrompt({ ...input, binary: fallbackBinary }, deps).then(resolve, reject);
      return true;
    };
    const resetInactivity = () => { if (inactivityTimer) clearTimeout(inactivityTimer); inactivityTimer = setTimeout(() => { teardown("Cursor CLI inactivity timeout"); finish(new Error("Cursor CLI inactivity timeout")); }, timeout("PI_CURSOR_CLI_TIMEOUT_MS", INACTIVITY_DEFAULT_MS)); };
    const abort = () => { teardown("Cursor CLI aborted"); finish(new Error("Cursor CLI aborted")); };
    firstTimer = setTimeout(() => { teardown("Cursor CLI first-line timeout"); finish(new Error("Cursor CLI first-line timeout")); }, timeout("PI_CURSOR_CLI_FIRST_LINE_TIMEOUT_MS", FIRST_LINE_DEFAULT_MS));
    input.signal?.addEventListener("abort", abort, { once: true });
    child.stderr?.on("data", (chunk: Buffer | string) => { stderr = (stderr + String(chunk)).slice(-STDERR_MAX); });
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") finish(error); });
    const lines = readline.createInterface({ input: child.stdout! });
    lines.on("line", (line) => { if (firstTimer) { clearTimeout(firstTimer); firstTimer = undefined; } resetInactivity(); const event = parseCursorStreamLine(line); if (event.kind === "system-init") sessionId = event.sessionId ?? sessionId; if (event.kind === "thinking-delta") input.onThinking?.(event.text); if (event.kind === "assistant-text") { output += event.text; input.onText?.(event.text); } if (event.kind === "tool-call-started") input.onToolStart?.(event.name, event.args); if (event.kind === "tool-call-completed") input.onToolEnd?.(event.name, false, event.result); if (event.kind === "result") { sawResult = true; sessionId = event.sessionId ?? sessionId; usage = event.usage; if (event.isError) finish(new Error(`Cursor CLI reported an error: ${event.text ?? "unknown error"}`)); } });
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (!retryWithFallback(error)) finish(new Error(`Cursor CLI spawn failed for ${target}: ${error.message}`));
    });
    child.once("close", (code: number | null) => { if (teardownReason) return finish(new Error(teardownReason)); if (code !== 0) return finish(new Error(`Cursor CLI exited ${code}: ${stderr}`)); if (!sawResult) return finish(new Error("Cursor CLI stream ended without a result event.")); finish(); });
    try { child.stdin?.end(input.prompt); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}
