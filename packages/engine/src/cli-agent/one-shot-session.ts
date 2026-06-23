/**
 * One-shot CLI agent sessions (CLI Agent Executor, U9).
 *
 * A *one-shot* session runs an adapter's NON-INTERACTIVE invocation
 * (`codex exec --json`, `droid exec --output-format json`, `pi --print`) to
 * completion in a working directory, streams its output to a
 * read-only terminal (so U10's attach surface works exactly as for interactive
 * sessions — but with input disabled server-side), collects the output, parses
 * the adapter's structured (JSON) result, and returns a typed result.
 *
 * Read-only enforcement: the dashboard transport's `isReadOnlySession` treats
 * `validator`/`planning` purposes as inherently read-only, and ALSO honors an
 * `autonomyPosture.readOnly === true` flag. One-shot sessions persist that flag
 * unconditionally so a `ce` (or any future) purpose is read-only too — the flag
 * is the durable, transport-readable signal, not a transient client hint.
 *
 * Design notes:
 * - The non-interactive command is built by `buildOneShotLaunch`, keyed off the
 *   adapter id. The interactive adapter launch builders intentionally don't
 *   model the `-p`/`exec` forms (those drive a REPL); one-shot is a distinct
 *   invocation that produces a single machine-readable result and exits.
 * - Output is merged stdout+stderr (a PTY has a single stream). The structured
 *   result is parsed from that stream per adapter. On a nonzero exit or an
 *   unparseable result we return a typed failure carrying a BOUNDED tail of the
 *   output as `stderr` (the best available diagnostic on a PTY).
 * - The PTY is reaped on completion: spawn → wait-for-exit → the session
 *   manager has already removed the live session and closed streams by the time
 *   `waitForExit` resolves.
 */

import type { CliSessionPurpose } from "@fusion/core";

import type { CliSessionManager } from "./session-manager.js";

// ── Bounds ────────────────────────────────────────────────────────────────

/** Maximum bytes of output retained for diagnostics on a failed one-shot. */
export const ONE_SHOT_STDERR_CAP_BYTES = 8 * 1024;

// ── One-shot launch (non-interactive command builder) ───────────────────────

/** A non-interactive invocation: command + args (the prompt is passed inline). */
export interface OneShotLaunchSpec {
  /** Adapter-specific extra args appended after the adapter's one-shot base. */
  extraArgs?: readonly string[];
  /** Adapter-specific settings forwarded to the session manager's spawn. */
  settings: Record<string, unknown>;
}

/**
 * Per-adapter one-shot settings. Each adapter's interactive `buildLaunch`
 * consults `settings`; one-shot mode flags the non-interactive form there.
 *
 * The flag (`oneShot: true`) plus the documented per-adapter args are forwarded
 * verbatim as launch settings. Adapters that don't yet branch on `oneShot`
 * still receive the prompt via injection fallback (see runOneShotSession).
 */
export function buildOneShotSettings(
  adapterId: string,
  prompt: string,
  base: Record<string, unknown> = {},
): Record<string, unknown> {
  const settings: Record<string, unknown> = { ...base, oneShot: true, oneShotPrompt: prompt };
  // The non-interactive arg sets are documented in each adapter file. We carry
  // them as explicit extraArgs so the session manager forwards them to spawn.
  switch (adapterId) {
    case "codex":
      settings.oneShotArgs = ["exec", "--json", prompt];
      break;
    case "droid":
      settings.oneShotArgs = ["exec", "--output-format", "json", prompt];
      break;
    case "pi":
      settings.oneShotArgs = ["--print", prompt];
      break;
    default:
      // generic / unknown: no structured form; prompt is injected.
      settings.oneShotArgs = [];
      break;
  }
  return settings;
}

// ── Structured one-shot result ──────────────────────────────────────────────

/** A successfully parsed one-shot result. */
export interface OneShotSuccess {
  ok: true;
  /** The session record id (for terminal attach / audit). */
  sessionId: string;
  /** Free-form structured payload parsed from the adapter's JSON output. */
  parsed: Record<string, unknown>;
  /** The text/result field the adapter surfaced (best-effort). */
  text: string;
  /** Full captured output (bounded by scrollback). */
  rawOutput: string;
}

/** Reason a one-shot failed. */
export type OneShotFailureReason = "nonzero-exit" | "unparseable" | "spawn-failed";

/** A typed one-shot failure — NEVER mistaken for a pass downstream. */
export interface OneShotFailure {
  ok: false;
  reason: OneShotFailureReason;
  /** The session record id, when a session was created. */
  sessionId: string | null;
  /** Process exit code, when the process ran. */
  exitCode: number | null;
  /** Bounded diagnostic tail of the merged PTY output. */
  stderr: string;
  /** Human-readable message. */
  message: string;
}

export type OneShotResult = OneShotSuccess | OneShotFailure;

// ── Per-adapter result parsing ──────────────────────────────────────────────

/**
 * Parse the structured result out of an adapter's one-shot output. Each adapter
 * emits JSON on its non-interactive path; the PTY merges it with any banner
 * lines, so we scan for the LAST decodable JSON object/array on the stream and
 * normalize a `text` field per adapter shape.
 *
 * Returns null when no decodable structured result is present (→ unparseable).
 */
export function parseOneShotOutput(
  adapterId: string,
  output: string,
): { parsed: Record<string, unknown>; text: string } | null {
  const objects = extractJsonObjects(output);
  if (objects.length === 0) return null;

  switch (adapterId) {
    case "codex": {
      // `codex exec --json` emits a stream of JSON events; the final
      // agent/assistant message carries the answer.
      const last = objects[objects.length - 1];
      const text = pickString(last, ["text", "message", "content", "result"]) ?? "";
      return { parsed: last, text };
    }
    case "droid": {
      // `droid exec --output-format json` → a single result object.
      const last = objects[objects.length - 1];
      const text = pickString(last, ["result", "text", "message", "output"]) ?? "";
      return { parsed: last, text };
    }
    case "pi": {
      const last = objects[objects.length - 1];
      const text = pickString(last, ["text", "result", "message", "content"]) ?? "";
      return { parsed: last, text };
    }
    default: {
      const last = objects[objects.length - 1];
      const text = pickString(last, ["text", "result", "message"]) ?? "";
      return { parsed: last, text };
    }
  }
}

/** Pull the first present string field from a parsed object. */
function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/**
 * Extract decodable top-level JSON objects from a (possibly noisy, possibly
 * line-delimited) output stream. Handles both JSONL (one object per line) and a
 * single pretty-printed object embedded in banner text.
 */
export function extractJsonObjects(output: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  // First try JSONL: each non-empty line that decodes to an object.
  let sawLineJson = false;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) continue;
    try {
      const v = JSON.parse(trimmed);
      if (v && typeof v === "object") {
        objects.push(v as Record<string, unknown>);
        sawLineJson = true;
      }
    } catch {
      // not a standalone JSON line; fall through to brace scanning below.
    }
  }
  if (sawLineJson) return objects;

  // Fallback: brace-balanced scan for a single embedded JSON object.
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const v = JSON.parse(output.slice(start, end + 1));
      if (v && typeof v === "object") objects.push(v as Record<string, unknown>);
    } catch {
      // unparseable
    }
  }
  return objects;
}

// ── Runner ──────────────────────────────────────────────────────────────────

export interface RunOneShotOptions {
  manager: CliSessionManager;
  adapterId: string;
  projectId: string;
  /** validator | planning | ce (chat/execute are interactive, not one-shot). */
  purpose: Extract<CliSessionPurpose, "validator" | "planning" | "ce">;
  prompt: string;
  /** Working directory the CLI runs in (also the PTY cwd). */
  cwd: string;
  taskId?: string | null;
  chatSessionId?: string | null;
  /** Extra adapter launch settings (model, profile…). Merged under one-shot. */
  settings?: Record<string, unknown>;
  /** Optional overall timeout (ms). On timeout the session is killed → failure. */
  timeoutMs?: number;
}

/**
 * Run an adapter's one-shot invocation to completion and return a typed result.
 *
 * Lifecycle: spawn (read-only record) → attach (collect output for the
 * read-only terminal + parsing) → wait for exit → parse → reap. On nonzero exit
 * or unparseable output, returns a typed {@link OneShotFailure} with a bounded
 * output tail — NEVER a silent success.
 */
export async function runOneShotSession(opts: RunOneShotOptions): Promise<OneShotResult> {
  const {
    manager,
    adapterId,
    projectId,
    purpose,
    prompt,
    cwd,
    taskId = null,
    chatSessionId = null,
    timeoutMs,
  } = opts;

  const settings = buildOneShotSettings(adapterId, prompt, opts.settings ?? {});

  let sessionId: string | null = null;
  try {
    const record = await manager.spawn({
      adapterId,
      projectId,
      purpose,
      taskId,
      chatSessionId,
      worktreePath: cwd,
      // Durable, transport-readable read-only flag. validator/planning are
      // already inherently read-only; this makes `ce` (and any future purpose)
      // read-only too. See isReadOnlySession in the dashboard transport.
      posture: { readOnly: true },
      settings,
    });
    sessionId = record.id;
  } catch (err) {
    return {
      ok: false,
      reason: "spawn-failed",
      sessionId,
      exitCode: null,
      stderr: "",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  // Attach to collect output (also exercises the read-only terminal stream).
  const attachment = manager.attach(sessionId);
  const chunks: Buffer[] = [];
  // Replay scrollback captured at attach (usually empty for a fresh spawn).
  if (attachment.scrollback.byteLength > 0) {
    chunks.push(Buffer.from(attachment.scrollback));
  }
  const drainPromise = (async () => {
    for await (const bytes of attachment.stream) {
      chunks.push(Buffer.from(bytes));
    }
  })();

  // For adapters whose one-shot form is NOT carried in args (generic fallback),
  // inject the prompt once ready. Adapters that consume the prompt via args
  // (claude/codex/droid/pi) ignore this — they already have it on argv.
  if (adapterId === "generic") {
    try {
      await manager.inject(sessionId, prompt);
    } catch {
      // session may exit immediately for non-interactive forms; ignore.
    }
  }

  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const exitPromise = manager.waitForExit(sessionId);
  const exit = await (timeoutMs && timeoutMs > 0
    ? Promise.race([
        exitPromise,
        new Promise<{ exitCode: number; signal: number | undefined }>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            manager.kill(sessionId as string, "killed");
            resolve({ exitCode: -1, signal: 9 });
          }, timeoutMs);
        }),
      ])
    : exitPromise);
  if (timer) clearTimeout(timer);

  // Ensure the stream is fully drained before reading output.
  attachment.detach();
  await drainPromise.catch(() => undefined);

  const rawOutput = Buffer.concat(chunks).toString("utf8");
  const boundedTail = boundedStderrTail(rawOutput);

  if (exit.exitCode !== 0 || timedOut) {
    return {
      ok: false,
      reason: "nonzero-exit",
      sessionId,
      exitCode: exit.exitCode,
      stderr: boundedTail,
      message: timedOut
        ? `one-shot ${adapterId} session timed out after ${timeoutMs}ms`
        : `one-shot ${adapterId} session exited with code ${exit.exitCode}`,
    };
  }

  const parsedResult = parseOneShotOutput(adapterId, rawOutput);
  if (!parsedResult) {
    return {
      ok: false,
      reason: "unparseable",
      sessionId,
      exitCode: exit.exitCode,
      stderr: boundedTail,
      message: `one-shot ${adapterId} produced no decodable structured result`,
    };
  }

  return {
    ok: true,
    sessionId,
    parsed: parsedResult.parsed,
    text: parsedResult.text,
    rawOutput,
  };
}

/** Bounded tail of merged output, for failure diagnostics. */
export function boundedStderrTail(output: string): string {
  const buf = Buffer.from(output, "utf8");
  if (buf.byteLength <= ONE_SHOT_STDERR_CAP_BYTES) return output;
  return buf.subarray(buf.byteLength - ONE_SHOT_STDERR_CAP_BYTES).toString("utf8");
}
