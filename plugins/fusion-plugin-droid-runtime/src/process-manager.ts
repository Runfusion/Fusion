/**
 * Process manager for spawning and managing Droid CLI subprocesses.
 *
 * Handles subprocess lifecycle: spawn with correct CLI flags, write NDJSON
 * messages to stdin, force-kill after result (CLI hangs bug), and stderr capture.
 * Also provides startup validation for CLI presence and authentication.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function debugLog(message: string): void {
  if (process.env.PI_DROID_CLI_DEBUG !== "1") return;
  console.error(`[droid-cli] ${message}`);
}

/**
 * Spawn a Droid CLI subprocess with all required flags for stream-json communication.
 *
 * @param modelId - The model ID to pass via --model flag
 * @param systemPrompt - Optional system prompt appended via --append-system-prompt
 * @param options - Optional cwd, AbortSignal, and effort level
 * @returns The spawned ChildProcess with piped stdin/stdout/stderr
 */
export function buildDroidSpawnArgs(
  modelId: string,
  systemPrompt?: string,
  options?: {
    effort?: string;
    mcpConfigPath?: string;
    resumeSessionId?: string;
    newSessionId?: string;
  },
): string[] {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    modelId,
  ];

  if (options?.resumeSessionId) {
    // Resume an existing session — CLI loads prior conversation from disk
    args.push("--resume", options.resumeSessionId);
  } else if (options?.newSessionId) {
    // First turn: create session with this ID so subsequent turns can --resume it
    args.push("--session-id", options.newSessionId);
  }

  if (systemPrompt) {
    // Write system prompt to a temp file to avoid ENAMETOOLONG on Windows.
    // Droid CLI's --append-system-prompt accepts a file path or literal text.
    const tmpFile = join(
      tmpdir(),
      `droid-cli-sysprompt-${process.pid}.txt`,
    );
    writeFileSync(tmpFile, systemPrompt, "utf-8");
    args.push("--append-system-prompt", tmpFile);
  }

  if (options?.effort) {
    args.push("--effort", options.effort);
  }

  if (options?.mcpConfigPath) {
    args.push("--mcp-config", options.mcpConfigPath);
  }

  return args;
}

export function spawnDroid(
  modelId: string,
  systemPrompt?: string,
  options?: {
    cwd?: string;
    signal?: AbortSignal;
    effort?: string;
    mcpConfigPath?: string;
    resumeSessionId?: string;
    newSessionId?: string;
  },
): ChildProcess {
  const args = buildDroidSpawnArgs(modelId, systemPrompt, {
    effort: options?.effort,
    mcpConfigPath: options?.mcpConfigPath,
    resumeSessionId: options?.resumeSessionId,
    newSessionId: options?.newSessionId,
  });

  const proc = spawn("droid", args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: options?.cwd ?? process.cwd(),
  });

  debugLog(`spawnDroid: pid=${proc.pid} model=${modelId}`);

  return proc as ChildProcess;
}

/**
 * Clean up the temp system prompt file created by spawnDroid.
 * Safe to call multiple times or when no file exists.
 */
export function cleanupSystemPromptFile(): void {
  try {
    unlinkSync(join(tmpdir(), `droid-cli-sysprompt-${process.pid}.txt`));
  } catch {
    // File doesn't exist or already deleted — ignore
  }
}

/**
 * Write a user message to the subprocess stdin as NDJSON.
 * Calls stdin.end() after writing the user message to signal EOF, allowing
 * Droid CLI to process the input and start generating.
 *
 * Accepts both string (text-only prompt) and array (ContentBlock[] with images)
 * content. JSON.stringify handles both natively. The stream-json protocol
 * supports either format in the content field.
 *
 * @param proc - The Claude subprocess
 * @param prompt - The prompt text or ContentBlock[] to send
 */
export function writeUserMessage(
  proc: ChildProcess,
  prompt: string | unknown[],
): void {
  const message = {
    type: "user",
    message: {
      role: "user",
      content: prompt,
    },
  };
  proc.stdin!.write(JSON.stringify(message) + "\n");
  proc.stdin!.end();
}

/**
 * Force-kill a subprocess immediately via SIGKILL.
 * No-ops if the process is already dead (killed or exited).
 * Cross-platform safe: Node.js treats SIGKILL as forceful termination on Windows.
 *
 * @param proc - The subprocess to force-kill
 */
export function forceKillProcess(proc: ChildProcess): void {
  if (proc.killed || proc.exitCode !== null) return;
  proc.kill("SIGKILL");
}

/** Registry of active subprocesses for cleanup on teardown. */
const activeProcesses = new Set<ChildProcess>();

/**
 * Hard ceiling on a single `droid models`/`droid model list` discovery spawn.
 * The droid CLI can keep stdout open via its stream-jsonrpc backend, so this
 * bound guarantees the spawn is SIGKILLed and the promise settles. Kept short
 * because discovery runs on the dashboard's per-session extension load path.
 */
const DROID_MODEL_DISCOVERY_TIMEOUT_MS = 10_000;

/**
 * Register a subprocess in the global process registry.
 * The process is automatically removed from the registry when it exits.
 *
 * @param proc - The subprocess to track
 */
export function registerProcess(proc: ChildProcess): void {
  activeProcesses.add(proc);
  proc.on("exit", () => activeProcesses.delete(proc));
}

/**
 * Force-kill all registered subprocesses and clear the registry.
 * Safe to call multiple times -- no-ops on already-dead processes.
 */
export function killAllProcesses(): void {
  for (const proc of activeProcesses) {
    forceKillProcess(proc);
  }
  activeProcesses.clear();
}

/**
 * Force-kill the subprocess after a 500ms grace period.
 * The Droid CLI hangs after emitting the result message (known bug).
 * Brief grace period allows final stdout flushing before force-kill.
 *
 * @param proc - The Claude subprocess to clean up
 */
export function cleanupProcess(proc: ChildProcess): void {
  setTimeout(() => {
    forceKillProcess(proc);
  }, 500);
}

/**
 * Attach a data listener to stderr and accumulate output into a buffer.
 *
 * @param proc - The Claude subprocess
 * @returns A function that returns the accumulated stderr string
 */
export function captureStderr(proc: ChildProcess): () => string {
  let buffer = "";
  proc.stderr!.on("data", (data: Buffer) => {
    buffer += data.toString();
  });
  return () => buffer;
}

/**
 * Run a one-shot `droid <args>` and resolve to the exit code.
 *
 * FNXC:CliRuntime 2026-06-15-07:35:
 * Third-party CLI presence/auth probes must be non-blocking in Fusion request and session-startup paths. Use spawn-based probes here because synchronous shell probes freeze the dashboard event loop during CLI cold start.
 *
 * Why: a Droid CLI cold start can take 1–3s, occasionally longer. When droid-cli's
 * factory is invoked from a per-request createFnAgent path (Fusion dashboard
 * does this on every chat send), sync probes freeze every other request.
 * This async variant uses spawn so the loop keeps turning while the subprocess
 * starts up.
 *
 * FNXC:CliRuntime 2026-06-20-17:25:
 * FN-6808/FN-6801 require this fire-and-forget auth/presence probe to never reject. Catch synchronous spawn throws from the Vitest child-process guard or platform launch errors and resolve 127, matching the async error sentinel so callers degrade to unauthenticated/not-present instead of surfacing unhandled promise rejections.
 */
function runDroidProbe(args: string[], timeoutMs = 45000): Promise<number> {
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn("droid", args, { stdio: "ignore" });
    } catch {
      resolve(127);
      return;
    }

    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already dead
      }
      resolve(124);
    }, timeoutMs);
    proc.once("error", () => {
      clearTimeout(timer);
      resolve(127);
    });
    proc.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

/**
 * Async, non-blocking variant of validateCliPresence.
 * Resolves with `{ok: true}` on success, `{ok: false, error}` on failure —
 * never rejects, so callers can fire-and-forget without unhandled rejections.
 */
export async function validateCliPresenceAsync(): Promise<
  { ok: true } | { ok: false; error: Error }
> {
  const code = await runDroidProbe(["--version"]);
  if (code === 0) return { ok: true };
  return {
    ok: false,
    error: new Error(
      "Droid CLI not found on PATH. Install Droid CLI and then run: droid auth login",
    ),
  };
}

/**
 * Async, non-blocking variant of validateCliAuth.
 * Returns true if authenticated. Logs a warning (does not throw) otherwise.
 */
export async function validateCliAuthAsync(): Promise<boolean> {
  const code = await runDroidProbe(["auth", "status"]);
  if (code === 0) return true;
  console.warn(
    "[droid-cli] Droid CLI is not authenticated. " +
      "Run 'droid auth login' to authenticate.",
  );
  return false;
}

/**
 * Parse model IDs out of `droid exec --help`. The help text lists the catalog
 * under `Available Models:` and `Custom Models:` headers, each entry indented as
 * `  <model-id>   <description>`. The trailing `Model details:` section (lines
 * like `  - Claude Opus 4.8: ...`) is intentionally excluded — those are prose,
 * not IDs. Exported for unit testing.
 */
export function parseDroidModelsFromHelp(helpText: string): string[] {
  const ids: string[] = [];
  let collecting = false;
  for (const line of helpText.split(/\r?\n/)) {
    // Section header at column 0, e.g. "Available Models:" / "Custom Models:".
    if (/^[A-Za-z][A-Za-z ]*Models:\s*$/.test(line)) {
      collecting = true;
      continue;
    }
    // Any other non-indented, non-empty line ends the current section
    // (notably "Model details:").
    if (collecting && line.trim() && !/^\s/.test(line)) {
      collecting = false;
    }
    if (!collecting) continue;
    // Indented "  <id>   <description>"; the id is the first whitespace-delimited
    // token (handles `custom:CC:-Opus-4.6-(Max)-0` and the like — no spaces).
    const match = line.match(/^\s+(\S+)\s{2,}\S/);
    if (match) ids.push(match[1]);
  }
  return Array.from(new Set(ids));
}

export async function discoverDroidModels(): Promise<string[]> {
  // The droid CLI has no `models`/`model list` command — those parse as a
  // *prompt* and launch a hung agent session. The catalog is printed by
  // `droid exec --help` (and exits cleanly).
  return new Promise<string[]>((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn("droid", ["exec", "--help"], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve([]);
      return;
    }

    // FNXC:CliRuntime 2026-06-21: keep discovery bounded. `droid exec --help`
    // exits on its own, but a SIGKILL-on-timeout guard ensures a wedged spawn
    // can never leak (the prior `droid models` form launched a persistent
    // stream-jsonrpc backend that never exited, piling up into a process storm
    // because the dashboard re-loads this extension per chat-send).
    let settled = false;
    const settle = (value: string[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (!proc.killed) proc.kill("SIGKILL");
      } catch {
        // already dead
      }
      resolve(value);
    };
    const timer = setTimeout(() => settle([]), DROID_MODEL_DISCOVERY_TIMEOUT_MS);

    let out = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    proc.once("error", () => settle([]));
    proc.once("exit", () => settle(parseDroidModelsFromHelp(out)));
  });
}
