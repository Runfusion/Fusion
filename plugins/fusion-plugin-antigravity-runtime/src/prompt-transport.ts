import { existsSync } from "node:fs";
import readline from "node:readline";
import { superviseSpawn } from "@fusion/core";
import { antigravityCliEnvironment } from "./cli-spawn.js";
import { parseAntigravityStreamLine } from "./stream-parser.js";

const STDERR_MAX = 16_384;
const FIRST_OUTPUT_TIMEOUT_MS = 30_000;
const INACTIVITY_TIMEOUT_MS = 120_000;
const MAX_TURN_LIFETIME_MS = 30 * 60_000;
const TERMINATION_GRACE_MS = 1_000;
export interface AntigravityPromptInput { binary?: string; model: string; cwd: string; prompt: string; signal?: AbortSignal; onText?: (text: string) => void; onThinking?: (text: string) => void; onToolStart?: (name: string, args?: Record<string, unknown>) => void; onToolEnd?: (name: string, isError: boolean, result?: unknown) => void }

/**
 * FNXC:AntigravityStreaming 2026-09-20-19:17:
 * agy turns use shell-free supervision, a minimal environment, and first-output
 * plus reset-on-output inactivity guards. A silent CLI must be reaped rather
 * than retaining a session or inheriting Fusion process credentials indefinitely.
 */
export async function launchAntigravityPrompt(input: AntigravityPromptInput): Promise<{ text: string; sessionId?: string }> {
  if (!existsSync(input.cwd)) throw new Error("Antigravity requires an existing session directory.");
  const supervised = superviseSpawn(input.binary?.trim() || "agy", ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--model", input.model], {
    cwd: input.cwd,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: antigravityCliEnvironment(),
    maxLifetimeMs: MAX_TURN_LIFETIME_MS,
  });
  const { child } = supervised;
  let output = "", stderr = "", sessionId: string | undefined, terminal = false, settled = false, settling = false;
  return new Promise((resolve, reject) => {
    let firstOutputTimer: NodeJS.Timeout | undefined;
    let inactivityTimer: NodeJS.Timeout | undefined;
    const clearGuards = () => {
      if (firstOutputTimer) clearTimeout(firstOutputTimer);
      if (inactivityTimer) clearTimeout(inactivityTimer);
      input.signal?.removeEventListener("abort", abort);
    };
    const reap = async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      supervised.kill("SIGTERM");
      const exited = await new Promise<boolean>((resolveGrace) => {
        const graceTimer = setTimeout(() => resolveGrace(false), TERMINATION_GRACE_MS);
        graceTimer.unref();
        void supervised.waitExit().then(() => {
          clearTimeout(graceTimer);
          resolveGrace(true);
        });
      });
      if (!exited) supervised.kill("SIGKILL");
      await supervised.waitExit();
    };
    /**
     * FNXC:AntigravityPromptReaping 2026-09-20-19:37:
     * Abort, watchdog, and provider-error exits retain a live MCP lease until
     * agy has closed. Reap the supervised process group before settling so a
     * caller cannot restore its MCP entry while the CLI still uses the bridge.
     */
    const finish = async (error?: Error, terminate = false) => {
      if (settling || settled) return;
      settling = true;
      clearGuards();
      if (terminate) await reap();
      settled = true;
      if (error) reject(error); else resolve({ text: output, sessionId });
    };
    const resetInactivity = () => {
      if (firstOutputTimer) { clearTimeout(firstOutputTimer); firstOutputTimer = undefined; }
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => { void finish(new Error("Antigravity stream became inactive."), true); }, INACTIVITY_TIMEOUT_MS);
      inactivityTimer.unref();
    };
    const abort = () => { void finish(new Error("Antigravity turn cancelled."), true); };
    firstOutputTimer = setTimeout(() => { void finish(new Error("Antigravity did not produce stream output in time."), true); }, FIRST_OUTPUT_TIMEOUT_MS);
    firstOutputTimer.unref();
    input.signal?.addEventListener("abort", abort, { once: true });
    child.stderr?.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-STDERR_MAX); });
    const lines = readline.createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
      resetInactivity();
      const event = parseAntigravityStreamLine(line);
      if (event.kind === "assistant-text") { output += event.text; input.onText?.(event.text); }
      else if (event.kind === "thinking-delta") input.onThinking?.(event.text);
      else if (event.kind === "tool-call-started") input.onToolStart?.(event.name, event.args);
      else if (event.kind === "tool-call-completed") input.onToolEnd?.(event.name, event.isError === true, event.result);
      else if (event.kind === "result") { terminal = true; sessionId = event.sessionId; if (event.isError) void finish(new Error("Antigravity reported an unsuccessful turn."), true); }
    });
    child.once("error", () => { void finish(new Error("Antigravity could not start. Check the configured agy binary."), true); });
    child.once("close", (code) => { if (input.signal?.aborted) { void finish(new Error("Antigravity turn cancelled.")); return; } if (code !== 0) { void finish(new Error(`Antigravity exited unexpectedly${stderr ? ". Check CLI authentication." : "."}`)); return; } if (!terminal) { void finish(new Error("Antigravity stream ended without a terminal result.")); return; } void finish(); });
    child.stdin?.end(`${JSON.stringify({ prompt: input.prompt })}\n`);
  });
}
