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
 */
function runDroidProbe(args: string[], timeoutMs = 45000): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn("droid", args, { stdio: "ignore" });
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

export async function discoverDroidModels(): Promise<string[]> {
  const attempts: string[][] = [["models", "--json"], ["model", "list", "--json"], ["models"]];

  for (const args of attempts) {
    const models = await new Promise<string[] | null>((resolve) => {
      const proc = spawn("droid", args, { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      proc.stdout?.on("data", (chunk: Buffer) => {
        out += chunk.toString();
      });
      proc.once("error", () => resolve(null));
      proc.once("exit", (code) => {
        if (code !== 0) return resolve(null);
        const trimmed = out.trim();
        if (!trimmed) return resolve([]);
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) {
            return resolve(
              parsed
                .map((entry) =>
                  typeof entry === "string"
                    ? entry
                    : typeof entry?.id === "string"
                      ? entry.id
                      : typeof entry?.name === "string"
                        ? entry.name
                        : undefined,
                )
                .filter((id): id is string => Boolean(id)),
            );
          }
        } catch {
          // not json, fall through to line parsing
        }
        resolve(
          trimmed
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean),
        );
      });
    });

    if (models && models.length > 0) {
      return Array.from(new Set(models));
    }
  }

  return [];
}
