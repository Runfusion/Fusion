import { forceKillGrokStream, spawnGrokStream, type GrokStreamProcess, type SpawnGrokStreamOptions } from "./cli-stream.js";
import { parseJsonOutput, parseLine } from "./stream-parser.js";
import type { AgentRuntime, AgentRuntimeOptions, AgentSession, AgentSessionResult, GrokSession } from "./types.js";

/*
FNXC:GrokCli 2026-07-10-12:52:
FN-7796: the production binary is xAI's Grok Build TUI. Its `--output-format streaming-json` path intermittently emits only `thought` events and then `stopReason:"Cancelled"` with no `text`, so the adapter now consumes the reliable `--output-format json` single object on subprocess close. Bridge object `text` to `onText`, object `thought` to `onThinking`, record `sessionId`, and make non-`EndTurn` empty-text terminals diagnosable instead of silent.

FNXC:GrokCliRouting 2026-07-10-10:54:
FN-7753's auto-derived `grok` runtime routing from a `grok-cli/*` model selection still preserves the concrete model. Normalize provider-qualified ids (`grok-cli/<id>` or `grok/<id>`) at session creation/prompt time and pass only the concrete id to `grok -m`; the no-model Runtime-mode path keeps the historical `grok/default` session fallback and omits `-m`.
*/

/**
 * Cold-start ceiling: if `grok -p --output-format json` produces no stdout
 * bytes within this window, treat it as a hung/failed subprocess and resolve
 * (never reject — mirrors the Droid adapter's resolve-on-error lifecycle so pi
 * always gets a well-formed, if diagnostic, result instead of an unhandled rejection).
 *
 * FNXC:GrokCli 2026-07-11-00:00:
 * FN-7838 raises Grok's cold-start ceiling from 60s to 120s because slow/cold first-token starts were killed prematurely. Operators can override the first-output guard with GROK_CLI_FIRST_OUTPUT_TIMEOUT_MS; invalid values fall back to the default so the guard is never disabled. This mirrors the OpenClaw/Hermes *_CLI_TIMEOUT_MS precedence pattern while keeping the 30-minute inactivity safety net separate.
 */
const DEFAULT_FIRST_OUTPUT_TIMEOUT_MS = 120_000;
const GROK_FIRST_OUTPUT_TIMEOUT_ENV = "GROK_CLI_FIRST_OUTPUT_TIMEOUT_MS";

function parsePositiveInteger(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function resolveFirstOutputTimeoutMs(): number {
  return parsePositiveInteger(process.env[GROK_FIRST_OUTPUT_TIMEOUT_ENV]) ?? DEFAULT_FIRST_OUTPUT_TIMEOUT_MS;
}

/**
 * Inactivity safety net: kill the subprocess if no stdout bytes arrive for
 * this long after the first chunk. Generous ceiling mirroring the Droid
 * adapter's rationale — the caller (Fusion's stuck-task detection / abort
 * signal) is the authoritative "this session is stuck" source; this is a
 * last-resort guard for a catastrophically hung `grok` process.
 */
const INACTIVITY_TIMEOUT_MS = 30 * 60_000;

/**
 * FNXC:GrokCli 2026-07-10-15:10:
 * FN-7779 root-cause helpers. The reported "No message" empty Grok bubble was
 * not a legitimate content-empty response — it was every silent grok failure
 * (missing/invalid GROK_API_KEY, bad flag, non-zero exit, missing binary)
 * collapsing into a resolve-with-no-output. The frontend placeholder (FN-7779
 * UI step) hid the symptom; these helpers cure the cause by turning each
 * silent failure into visible, diagnosable text so the operator sees WHY grok
 * returned nothing. Retargeted for FN-7796's single-JSON-object contract —
 * the schema no longer carries a `tool_use`/`error` NDJSON event, so only the
 * spawn/process/exit-code failure surfaces below apply.
 */
function emitFailureText(session: GrokSession, text: string): void {
  session.callbacks.onText?.(text);
}

function describeSpawnFailure(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error ?? "unknown error");
  return `Grok CLI failed to start: ${reason}. Ensure the \`grok\` binary is installed and on PATH, or set GROK_API_KEY to use the direct xAI endpoint.`;
}

/**
 * Build the operator-facing message for a run that finished with NO renderable
 * content. Prefer the captured stderr (the channel for fatal, pre-JSON
 * failures); otherwise fall back to a non-zero-exit diagnostic. Returns
 * undefined for a genuinely clean, content-less exit (code 0, no stderr) so a
 * legitimately empty response is not decorated with a false error.
 */
function describeSilentFailure(stderr: string, exitCode: number | null | undefined): string | undefined {
  const trimmed = stderr.trim();
  if (trimmed) {
    return `Grok CLI returned no content. ${trimmed}`;
  }
  if (typeof exitCode === "number" && exitCode !== 0) {
    return `Grok CLI exited with code ${exitCode} and produced no output. Check that GROK_API_KEY (or the \`grok\` login) is configured and the selected model is valid.`;
  }
  return undefined;
}

function normalizeGrokCliModel(model: string | undefined): string | undefined {
  const normalized = model?.trim();
  if (!normalized) return undefined;
  for (const prefix of ["grok-cli/", "grok/"]) {
    if (normalized.startsWith(prefix)) {
      const stripped = normalized.slice(prefix.length).trim();
      return stripped.length > 0 ? stripped : undefined;
    }
  }
  return normalized;
}

function modelForCli(model: string | undefined): string | undefined {
  const normalized = normalizeGrokCliModel(model);
  return normalized && normalized !== "default" ? normalized : undefined;
}

function compactDiagnostic(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function formatCloseDiagnostic(code: number | null, signal: NodeJS.Signals | null, stderr: string): string {
  const detail = compactDiagnostic(stderr);
  const exitDetail = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
  return detail ? `Grok CLI failed (${exitDetail}): ${detail}` : `Grok CLI failed with ${exitDetail} and no stderr output.`;
}

function formatNoJsonDiagnostic(firstStdoutChunk: string | undefined): string {
  const firstChunk = firstStdoutChunk ? compactDiagnostic(firstStdoutChunk) : "";
  if (firstChunk) {
    return `Grok CLI produced stdout but no parseable JSON response for a headless prompt; first output: ${firstChunk}`;
  }
  return "Grok CLI produced no JSON output for a headless prompt; this usually means the binary on PATH is not xAI's supported Grok Build TUI headless implementation, did not recognize -p/--output-format json, or exited interactive mode immediately after stdin EOF.";
}

function formatTerminalNoTextDiagnostic(stopReason: string): string {
  return `Grok CLI ended with stopReason ${stopReason} and produced no assistant text.`;
}

function appendMessage(session: GrokSession, role: "user" | "assistant", content: string): void {
  session.state.messages.push({ role, content });
}

interface ParsedPromptOutput {
  text: string;
  thought?: string;
  stopReason?: string;
  sessionId?: string;
  parsed: boolean;
}

function parsePromptOutput(stdout: string): ParsedPromptOutput {
  const json = parseJsonOutput(stdout);
  if (json) {
    return {
      text: json.text ?? "",
      thought: json.thought,
      stopReason: json.stopReason,
      sessionId: json.sessionId,
      parsed: true,
    };
  }

  let text = "";
  let thought = "";
  let stopReason: string | undefined;
  let sessionId: string | undefined;
  let parsed = false;
  for (const line of stdout.split(/\r?\n/)) {
    const event = parseLine(line);
    if (!event) continue;
    parsed = true;
    if (event.type === "text") {
      text += event.data;
    } else if (event.type === "thought") {
      thought += event.data;
    } else {
      stopReason = event.stopReason;
      sessionId = event.sessionId;
    }
  }

  return { text, thought: thought || undefined, stopReason, sessionId, parsed };
}

export interface GrokRuntimeAdapterOptions {
  /** Binary name/path to invoke. Defaults to "grok" (PATH resolution). */
  binary?: string;
  /** Injectable spawn seam for tests — defaults to the real `spawnGrokStream`. */
  spawn?: (binary: string, prompt: string, options?: SpawnGrokStreamOptions) => GrokStreamProcess;
}

export class GrokRuntimeAdapter implements AgentRuntime {
  readonly id = "grok";
  readonly name = "Grok Runtime";
  private readonly binary: string;
  private readonly spawnFn: (binary: string, prompt: string, options?: SpawnGrokStreamOptions) => GrokStreamProcess;

  constructor(options?: GrokRuntimeAdapterOptions) {
    this.binary = options?.binary ?? "grok";
    this.spawnFn = options?.spawn ?? spawnGrokStream;
  }

  async createSession(
    options: {
      defaultModelId?: string;
      systemPrompt?: string;
      onText?: (text: string) => void;
      onThinking?: (text: string) => void;
      onToolStart?: (toolName: string, args?: unknown) => void;
      onToolEnd?: (toolName: string, isError: boolean, result?: unknown) => void;
    } = {},
  ): Promise<AgentSessionResult> {
    const model = normalizeGrokCliModel(options.defaultModelId) ?? "grok/default";
    const messages: unknown[] = [];
    const session: GrokSession = {
      model,
      systemPrompt: options.systemPrompt,
      messages,
      state: { messages },
      sessionId: undefined,
      lastModelDescription: `grok/${model}`,
      callbacks: {
        onText: options.onText,
        onThinking: options.onThinking,
        onToolStart: options.onToolStart,
        onToolEnd: options.onToolEnd,
      },
    };
    return { session, sessionFile: undefined };
  }

  async promptWithFallback(session: AgentSession, prompt: string, options?: AgentRuntimeOptions): Promise<void> {
    const grokSession = session as GrokSession;
    const cwd = options?.cwd;
    const signal = options?.signal;
    appendMessage(grokSession, "user", prompt);
    const firstOutputTimeoutMs = resolveFirstOutputTimeoutMs();

    return new Promise<void>((resolve) => {
      let proc: GrokStreamProcess;
      try {
        proc = this.spawnFn(this.binary, prompt, { cwd, model: modelForCli(grokSession.model), signal });
      } catch (spawnError) {
        // Spawn threw synchronously (e.g. binary not found without shell
        // resolution) — resolve, never reject, matching the CLI-adapter
        // contract of always producing a well-formed result while retaining
        // the concrete diagnostic for callers that surface session.state, AND
        // (FN-7779 root-cause) surfacing the reason as visible text so the
        // user sees a diagnosable failure instead of an empty bubble.
        const message = spawnError instanceof Error ? spawnError.message : String(spawnError);
        const diagnostic = compactDiagnostic(`Grok CLI spawn failed: ${message}`);
        grokSession.state.errorMessage = diagnostic;
        const failureMessage = describeSpawnFailure(spawnError);
        emitFailureText(grokSession, failureMessage);
        appendMessage(grokSession, "assistant", failureMessage);
        resolve();
        return;
      }

      let settled = false;
      let firstOutputReceived = false;
      let firstStdoutChunk: string | undefined;
      let assistantText = "";
      let diagnosticEmitted = false;
      let stderr = "";
      let stdout = "";
      let firstOutputTimer: NodeJS.Timeout | undefined;
      let inactivityTimer: NodeJS.Timeout | undefined;
      // FNXC:GrokCli 2026-07-10-15:10: FN-7779 root-cause — track whether any
      // renderable content (real assistant text) or a fallback diagnostic has
      // already been surfaced via onText, so a run that finished with NO
      // renderable content gets exactly one visible reason instead of an
      // empty "No message" assistant bubble (and never a duplicate
      // diagnostic on top of real content).
      let contentEmitted = false;

      const setErrorMessage = (message: string) => {
        if (message.trim().length === 0) return;
        grokSession.state.errorMessage = message;
      };

      const emitDiagnosticText = (message: string | undefined) => {
        const diagnostic = message?.trim();
        if (!diagnostic || assistantText || diagnosticEmitted || contentEmitted) return;
        diagnosticEmitted = true;
        contentEmitted = true;
        grokSession.callbacks.onText?.(diagnostic);
        appendMessage(grokSession, "assistant", diagnostic);
      };

      const emitParsedOutput = (parsed: ParsedPromptOutput) => {
        if (parsed.thought) {
          grokSession.callbacks.onThinking?.(parsed.thought);
        }
        if (parsed.sessionId) {
          grokSession.sessionId = parsed.sessionId;
        }
        if (parsed.text.length > 0) {
          assistantText += parsed.text;
          contentEmitted = true;
          grokSession.callbacks.onText?.(parsed.text);
          return;
        }
        if (parsed.stopReason && parsed.stopReason !== "EndTurn") {
          setErrorMessage(formatTerminalNoTextDiagnostic(parsed.stopReason));
        }
      };

      /*
      FNXC:GrokCli 2026-07-10-00:00:
      A failing headless `grok` run can close stdout before the child `close` event reports its non-zero exit and stderr. Resolving too early made dashboard Chat persist an empty assistant message before the diagnostic existed. Finalize only from subprocess close/error or lifecycle timeouts, and store concrete stderr/parse error details on session.state.errorMessage so shared chat/executor seams can surface the reason without breaking the resolve-never-reject runtime contract.

      FNXC:GrokCli 2026-07-10-12:52:
      FN-7796 replaces the streaming-json/NDJSON contract with a single JSON object parsed once on subprocess close (`parsePromptOutput`/`emitParsedOutput`), because streaming-json intermittently emitted only `thought` + `stopReason:"Cancelled"` with no `text`. `stdout` is accumulated in full across `data` chunks rather than parsed line-by-line as it arrives.

      FNXC:GrokCli 2026-07-10-15:10:
      FN-7779 root-cause — the above only covered the zero-output shape. A run
      that DID exit non-zero (or produced fatal stderr) with no renderable
      content still resolved silently once `session.state.errorMessage` had
      already been consumed by `emitDiagnosticText` for a different reason (or
      not set at all). If nothing was rendered AND no diagnostic has been
      emitted yet, fall back to `describeSilentFailure` (stderr-first, then a
      non-zero-exit reason) so every silent failure surface gets a visible,
      diagnosable `onText` — never a bare empty resolve.
      */
      const finish = (exitCode?: number | null) => {
        if (settled) return;
        settled = true;
        if (firstOutputTimer) clearTimeout(firstOutputTimer);
        if (inactivityTimer) clearTimeout(inactivityTimer);
        if (assistantText) {
          appendMessage(grokSession, "assistant", assistantText);
        } else {
          // FN-7779's stderr/exit-code diagnostic takes priority when the run
          // actually failed (non-empty stderr or non-zero exit): it names the
          // concrete cause. Only fall back to the FN-7796 parse-shape
          // diagnostic (session.state.errorMessage, e.g. "produced no JSON
          // output") for the remaining case that describeSilentFailure can't
          // describe — a code-0 exit with no stderr that still produced no
          // parseable output.
          const failure = describeSilentFailure(stderr, exitCode);
          if (failure && !contentEmitted) {
            contentEmitted = true;
            emitFailureText(grokSession, failure);
            appendMessage(grokSession, "assistant", failure);
          } else {
            emitDiagnosticText(grokSession.state.errorMessage);
          }
        }
        resolve();
      };

      const resetInactivityTimer = () => {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
          setErrorMessage(
            `Grok CLI stopped producing stdout for ${INACTIVITY_TIMEOUT_MS}ms during a headless prompt; the process was killed.`,
          );
          forceKillGrokStream(proc);
          finish();
        }, INACTIVITY_TIMEOUT_MS);
      };

      firstOutputTimer = setTimeout(() => {
        if (firstOutputReceived) return;
        setErrorMessage(
          `Grok CLI produced no stdout within ${firstOutputTimeoutMs}ms for a headless prompt; the process was killed.`,
        );
        forceKillGrokStream(proc);
        finish();
      }, firstOutputTimeoutMs);

      proc.stdout?.on("data", (chunk: Buffer | string) => {
        const text = chunk.toString();
        if (!firstOutputReceived) {
          firstOutputReceived = true;
          firstStdoutChunk = text;
          if (firstOutputTimer) clearTimeout(firstOutputTimer);
        }
        stdout += text;
        resetInactivityTimer();
      });

      proc.stderr?.on("data", (chunk: Buffer | string) => {
        // FNXC:GrokCli 2026-07-10-15:10: FN-7779 root-cause — xAI's Grok
        // Build TUI writes fatal, pre-JSON failures (missing API key,
        // invalid flag, auth error) to stderr with no JSON on stdout.
        // Reading stdout alone would lose the entire failure reason, so
        // stderr is captured for both the FN-7796 close diagnostic and the
        // FN-7779 silent-failure fallback below. Capped to avoid unbounded
        // growth on a pathologically chatty process.
        if (stderr.length < 8192) stderr += chunk.toString();
      });

      proc.on("error", (procError) => {
        // FNXC:GrokCli 2026-07-10-15:10: FN-7779 root-cause — spawn/runtime
        // process error (e.g. ENOENT for a missing `grok` binary) previously
        // resolved into an empty bubble; surface the reason both on
        // session.state (unchanged historical format) and as visible text
        // via finish()'s silent-failure fallback.
        const message = procError instanceof Error ? procError.message : String(procError);
        if (!assistantText) {
          setErrorMessage(compactDiagnostic(`Grok CLI process error: ${message}`));
        }
        if (!contentEmitted && !stderr) {
          stderr = describeSpawnFailure(procError);
        }
        finish();
      });

      proc.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
        const parsed = parsePromptOutput(stdout);
        if (parsed.parsed) {
          emitParsedOutput(parsed);
        }

        const failed = typeof code === "number" ? code !== 0 : Boolean(signal);
        if (!assistantText && failed) {
          setErrorMessage(formatCloseDiagnostic(typeof code === "number" ? code : null, signal, stderr));
        } else if (!assistantText && !parsed.parsed && typeof code === "number" && code === 0) {
          setErrorMessage(formatNoJsonDiagnostic(firstStdoutChunk));
        }
        finish(code);
      });
    });
  }

  describeModel(session: AgentSession): string {
    const grokSession = session as GrokSession;
    return grokSession.lastModelDescription || `grok/${grokSession.model ?? "default"}`;
  }
}
