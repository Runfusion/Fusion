/**
 * Provider orchestration for bridging pi requests to the Droid CLI subprocess.
 *
 * streamViaCli is the core function that:
 * 1. Builds the prompt from conversation context
 * 2. Spawns a Droid CLI subprocess with correct flags
 * 3. Writes the user message to stdin as NDJSON
 * 4. Reads stdout line-by-line, parsing NDJSON
 * 5. Routes stream events through the event bridge to pi's stream
 * 6. Handles result/error messages and cleans up the subprocess
 * 7. Implements break-early: kills subprocess at message_stop when
 *    built-in or custom-tools MCP tool_use blocks are seen
 * 8. Hardened lifecycle: inactivity timeout, subprocess exit handler,
 *    streamEnded guard, abort via SIGKILL, process registry
 */

import { createInterface } from "node:readline";
import {
  AssistantMessageEventStream,
  type Api,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  buildPrompt,
  buildSystemPrompt,
  buildResumePrompt,
  type PiContext,
} from "./prompt-builder.js";
import {
  spawnDroid,
  writeUserMessage,
  cleanupProcess,
  captureStderr,
  forceKillProcess,
  registerProcess,
  cleanupSystemPromptFile,
  buildDroidSpawnArgs,
} from "./process-manager.js";
import { parseLine } from "./stream-parser.js";
import { createEventBridge } from "./event-bridge.js";
import { mapThinkingEffort } from "./thinking-config.js";
import { isPiKnownDroidTool } from "./tool-mapping.js";
/**
 * Inactivity safety net for the Droid CLI subprocess.
 *
 * Set very high (30 minutes) because the caller is the authoritative source of
 * truth for "this session is stuck": Fusion's engine runs a `StuckTaskDetector`
 * with a configurable heartbeat (default 1 hour) and aborts the session via
 * `AbortSignal` when it decides the agent has gone quiet. droid-cli already
 * forwards that signal to the subprocess (`forceKillProcess` on `signal.abort`).
 *
 * A short timeout here was racing the engine: Sonnet 4.6 with extended thinking
 * on the triage prompt (~40k chars) routinely goes >3 minutes between thinking
 * deltas, and we were killing those subprocesses before they could write
 * PROMPT.md and call `fn_review_spec`. The half-hour ceiling is just a
 * last-resort guard for catastrophically hung processes when no abort signal
 * arrives (e.g. someone embeds droid-cli without a stuck detector).
 */
const INACTIVITY_TIMEOUT_MS = 30 * 60_000;

/**
 * Cold-start ceiling: kill the subprocess if it hasn't produced a single line
 * of stdout within this window. Distinct from INACTIVITY_TIMEOUT_MS so a hung
 * binary (no output ever) is reported with a clear cause instead of being
 * indistinguishable from a slow-thinking turn.
 *
 * FNXC:DroidCli 2026-07-11-00:00:
 * FN-7838 raises Droid's cold-start ceiling from 60s to 120s because slow/cold first-token starts were killed prematurely. Operators can override the first-line guard with PI_DROID_CLI_FIRST_LINE_TIMEOUT_MS; invalid values fall back to the default so the guard is never disabled. This mirrors the OpenClaw/Hermes *_CLI_TIMEOUT_MS precedence pattern while keeping the 30-minute inactivity safety net separate.
 */
const DEFAULT_FIRST_LINE_TIMEOUT_MS = 120_000;
const PI_DROID_FIRST_LINE_TIMEOUT_ENV = "PI_DROID_CLI_FIRST_LINE_TIMEOUT_MS";

function parsePositiveInteger(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function resolveFirstLineTimeoutMs(): number {
  return parsePositiveInteger(process.env[PI_DROID_FIRST_LINE_TIMEOUT_ENV]) ?? DEFAULT_FIRST_LINE_TIMEOUT_MS;
}
function isDebugStreamEnabled(): boolean {
  return process.env.PI_DROID_CLI_DEBUG === "1";
}

function debugLog(message: string): void {
  if (!isDebugStreamEnabled()) return;
  console.error(`[droid-cli] ${message}`);
}

/** Extended stream options: pi's SimpleStreamOptions plus optional cwd and mcpConfigPath */
type StreamViaCLiOptions = SimpleStreamOptions & {
  cwd?: string;
  mcpConfigPath?: string;
};

/**
 * Stream a response from Droid CLI as an AssistantMessageEventStream.
 *
 * Orchestrates the full subprocess lifecycle: spawn, write prompt, parse NDJSON,
 * bridge events, handle result, and clean up. Implements break-early pattern:
 * at message_stop, if any built-in or custom-tools MCP tool was seen, kills
 * the subprocess before Droid CLI can auto-execute the tools.
 *
 * Hardened with: inactivity timeout (180s), subprocess exit handler with stderr
 * surfacing, streamEnded guard against double errors, abort via SIGKILL, and
 * process registry integration for teardown cleanup.
 *
 * @param model - The model to use (from pi's model catalog)
 * @param context - The conversation context with messages and system prompt
 * @param options - Optional cwd, abort signal, reasoning level, thinking budgets, and mcpConfigPath
 * @returns An AssistantMessageEventStream that receives bridged events
 */
export function streamViaCli(
  model: Model<Api>,
  context: PiContext,
  options?: StreamViaCLiOptions,
): AssistantMessageEventStream {
  // @ts-expect-error — tsc can't verify AssistantMessageEventStream is a value
  // through pi-ai's `export *` re-export chain. The class constructor exists at runtime.
  const stream = new AssistantMessageEventStream();

  (async () => {
    let proc: ReturnType<typeof spawnDroid> | undefined;
    let abortHandler: (() => void) | undefined;

    try {
      const cwd = options?.cwd ?? process.cwd();
      const firstLineTimeoutMs = resolveFirstLineTimeoutMs();

      // Resume if pi provides a session ID AND this isn't the first turn.
      // Pi passes sessionId on every call (including first), but we can only
      // --resume a CLI session that already exists on disk from a prior turn.
      const resumeSessionId =
        options?.sessionId && context.messages.length > 1
          ? options.sessionId
          : undefined;

      // Build prompt: if resuming, only send the latest user turn;
      // otherwise build the full flattened conversation history
      const prompt = resumeSessionId
        ? buildResumePrompt(context)
        : buildPrompt(context);
      const systemPrompt = resumeSessionId
        ? undefined
        : buildSystemPrompt(context, cwd);

      // Compute effort level from reasoning options
      const effort = mapThinkingEffort(
        options?.reasoning,
        model.id,
        options?.thinkingBudgets,
      );

      const spawnOptions = {
        cwd,
        signal: options?.signal,
        effort,
        mcpConfigPath: options?.mcpConfigPath,
        resumeSessionId,
        newSessionId: !resumeSessionId ? options?.sessionId : undefined,
      };

      // Spawn subprocess
      proc = spawnDroid(model.id, systemPrompt || undefined, spawnOptions);
      const getStderr = captureStderr(proc);

      // Register in global process registry for teardown cleanup
      registerProcess(proc);
      const spawnArgs = buildDroidSpawnArgs(model.id, undefined, {
        effort,
        mcpConfigPath: options?.mcpConfigPath,
        resumeSessionId,
        newSessionId: !resumeSessionId ? options?.sessionId : undefined,
      });
      debugLog(
        `spawned droid subprocess pid=${proc.pid ?? "unknown"} args=${JSON.stringify(spawnArgs)}`, 
      );

      // Write user message to subprocess stdin
      writeUserMessage(proc, prompt);
      debugLog("user message written to stdin, stdin.end() called");

      // Create event bridge (before endStreamWithError so bridge is in scope)
      const bridge = createEventBridge(stream, model);

      // Guard against double stream.end() and double error events.
      // First error path wins; subsequent ones are no-ops.
      let streamEnded = false;

      /**
       * End the stream with an error, using a "done" event instead of "error".
       *
       * Why "done" not "error": AssistantMessageEventStream.extractResult()
       * returns event.error (a string) for error events, but agent-loop.js
       * then calls message.content.filter() on the result, crashing because
       * a string has no .content property. By pushing "done" with a valid
       * AssistantMessage (content:[]), pi gets a well-formed object.
       */
      function endStreamWithError(errMsg: string) {
        if (streamEnded || broken) return;
        streamEnded = true;
        const output = bridge.getOutput();
        const errorMessage = {
          ...output,
          content: output.content?.length
            ? output.content
            : [{ type: "text" as const, text: `Error: ${errMsg}` }],
          stopReason: "stop" as const,
        };
        stream.push({
          type: "done",
          reason: "stop",
          message: errorMessage,
        });
        stream.end();
      }

      // Inactivity timeout: kill subprocess if no stdout for INACTIVITY_TIMEOUT_MS
      let inactivityTimer: ReturnType<typeof setTimeout> | undefined;

      function resetInactivityTimer() {
        if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
          forceKillProcess(proc!);
          endStreamWithError(
            `Droid CLI subprocess timed out: no output for ${INACTIVITY_TIMEOUT_MS / 1000} seconds`,
          );
        }, INACTIVITY_TIMEOUT_MS);
      }

      // Set up abort signal handler -- uses SIGKILL for immediate force-kill
      if (options?.signal) {
        abortHandler = () => {
          if (proc) {
            forceKillProcess(proc);
          }
        };

        if (options.signal.aborted) {
          abortHandler();
          return;
        }
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      // Track tool_use blocks for break-early decision at message_stop
      let sawBuiltInOrCustomTool = false;
      let firstLineReceived = false;
      // Guard against buffered readline lines firing after rl.close()
      let broken = false;

      // Set up readline for line-by-line NDJSON parsing
      const rl = createInterface({
        input: proc.stdout!,
        crlfDelay: Infinity,
        terminal: false,
      });

      // Handle process error -- use endStreamWithError for guard
      proc.on("error", (err: Error) => {
        if (broken) return; // Break-early killed the process intentionally
        const stderr = getStderr();
        endStreamWithError(stderr || err.message);
      });

      // Handle subprocess close -- surface crashes with stderr and exit code
      proc.on("close", (code: number | null, _signal: string | null) => {
        clearTimeout(inactivityTimer);
        debugLog(`subprocess closed: code=${code} signal=${_signal}`);
        if (broken) return; // Break-early kill, expected
        const stderr = getStderr().trim();
        if (stderr) {
          console.warn(`[droid-cli] Droid CLI stderr on close: ${stderr}`);
        }
        if (code !== 0 && code !== null) {
          const message = stderr
            ? `Droid CLI exited with code ${code}: ${stderr}`
            : `Droid CLI exited unexpectedly with code ${code}`;
          endStreamWithError(message);
        }
      });

      // Start inactivity timer after writing user message
      resetInactivityTimer();

      // Cold-start ceiling: only fires if firstLineReceived stays false. Cleared
      // when the first line arrives, when proc closes, or on break-early. This
      // distinguishes "droid never started" from "droid is taking a long time
      // between thinking deltas" so the inactivity kill carries actionable info.
      const firstLineTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
        if (firstLineReceived) return;
        forceKillProcess(proc!);
        endStreamWithError(
          `Droid CLI produced no output within ${firstLineTimeoutMs / 1000}s — likely binary hang or auth failure (try \`droid --version\` and \`droid auth status\`)`,
        );
      }, firstLineTimeoutMs);
      proc.on("close", () => clearTimeout(firstLineTimer));

      // Process NDJSON lines from stdout using event-based callback
      // NOTE: Using 'line' event instead of `for await` because the async
      // iterator batches lines, breaking real-time streaming to pi.
      rl.on("line", (line: string) => {
        if (!firstLineReceived) {
          firstLineReceived = true;
          debugLog("first stdout line received from Droid CLI");
        }
        if (broken) return; // Guard: ignore buffered lines after break-early

        // Reset inactivity timer on each line of output
        resetInactivityTimer();

        const msg = parseLine(line);
        if (!msg) return;

        if (msg.type === "stream_event") {
          // Only forward top-level events to pi's event bridge.
          // Sub-agent events (parent_tool_use_id !== null) are internal to the CLI.
          const isTopLevel = !msg.parent_tool_use_id;
          if (isTopLevel) {
            bridge.handleEvent(msg.event);
          }

          // Track tool_use blocks for break-early decision (top-level only)
          if (
            isTopLevel &&
            msg.event.type === "content_block_start" &&
            msg.event.content_block?.type === "tool_use"
          ) {
            const toolName = msg.event.content_block.name;
            if (toolName) {
              const piKnownTool = isPiKnownDroidTool(toolName);
              debugLog(
                `top-level tool_use seen: ${toolName} (piKnown=${piKnownTool ? "yes" : "no"})`,
              );
              if (piKnownTool) {
                // Built-in tool (Read/Write/etc.) OR custom MCP tool (mcp__custom-tools__*)
                // Internal Claude Code tools (ToolSearch, Task, etc.) are excluded
                sawBuiltInOrCustomTool = true;
              }
            }
          }

          // Break-early at message_stop: kill subprocess before CLI auto-executes tools
          // Only on top-level message_stop — sub-agent message_stop is internal
          if (
            isTopLevel &&
            msg.event.type === "message_stop" &&
            sawBuiltInOrCustomTool
          ) {
            debugLog("break-early triggered at message_stop after pi-known tool_use");
            broken = true; // Set guard BEFORE rl.close() to prevent buffered lines
            clearTimeout(inactivityTimer);
            clearTimeout(firstLineTimer);
            // Pi will execute these tools. Kill subprocess to prevent CLI from executing them.
            forceKillProcess(proc!);
            rl.close();
            return; // Don't process further -- done event already pushed by event bridge
          }
        } else if (msg.type === "control_request") {
          debugLog(
            `unexpected control_request received (stdin already closed): ${msg.request_id}`,
          );
        } else if (msg.type === "result") {
          if (msg.subtype === "error") {
            endStreamWithError(msg.error ?? "Unknown error from Droid CLI");
          }
          // For both success and error: clean up the subprocess
          clearTimeout(inactivityTimer);
          clearTimeout(firstLineTimer);
          cleanupProcess(proc!);
          rl.close();
        }
      });

      // Wait for readline to close (result received or process ended).
      // Also resolve on subprocess close: if SIGKILL races readline (e.g. after
      // an external abort or watchdog kill), `rl` may never emit "close" because
      // its input stream was destroyed mid-buffer. Forcing rl.close() from the
      // proc close handler guarantees this await unblocks instead of hanging
      // and triggering the engine's "executor did not unwind within 60s" path.
      await new Promise<void>((resolve) => {
        rl.on("close", resolve);
        proc!.on("close", () => {
          try { rl.close(); } catch { /* already closed */ }
          resolve();
        });
      });

      // Push done event after readline closes (async). Pushing synchronously
      // inside handleMessageStop prevents pi from executing tools.
      // Guard with streamEnded to avoid pushing done after an error was already pushed.
      if (!streamEnded) {
        const output = bridge.getOutput();
        const contentEvents = output.content || [];

        if (contentEvents.length === 0) {
          console.warn(
            `[droid-cli] Droid CLI closed without content events (model=${model.id}, sessionId=${options?.sessionId ?? "none"})`,
          );
        }

        // If stopReason is toolUse but there are no pi-known tool calls in content,
        // it means only user MCP tools were called (filtered by event bridge).
        // Override to "stop" so pi doesn't try to execute non-existent tools.
        const piToolCalls = (output.content || []).filter(
          (c: TextContent | ThinkingContent | ToolCall) => c.type === "toolCall",
        );
        const effectiveReason =
          output.stopReason === "toolUse" && piToolCalls.length === 0
            ? "stop"
            : output.stopReason;

        streamEnded = true;
        stream.push({
          type: "done",
          reason:
            effectiveReason === "toolUse"
              ? "toolUse"
              : effectiveReason === "length"
                ? "length"
                : "stop",
          message: { ...output, stopReason: effectiveReason },
        });
        stream.end();
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Push a "done" event with a text error so pi gets a valid AssistantMessage.
      // Pushing type:"error" would require an AssistantMessage in the error field,
      // but we don't have a full AssistantMessage here.
      stream.push({
        type: "done",
        reason: "stop",
        message: {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: `Error: ${errMsg}` }],
          api: "droid-cli",
          provider: model.provider,
          model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop" as const,
          timestamp: Date.now(),
        },
      });
      stream.end();
    } finally {
      // Clean up abort listener
      if (options?.signal && abortHandler) {
        options.signal.removeEventListener("abort", abortHandler);
      }
      cleanupSystemPromptFile();
    }
  })();

  return stream;
}
