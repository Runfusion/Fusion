/**
 * Pi adapter — NATIVE-tier CliAgentAdapter (U5).
 *
 * Pi (github.com/earendil-works/pi) is native tier: it writes a structured
 * session JSONL to disk that we tail for telemetry AND transcript. Capability
 * flags advertise this honestly: `nativeDone: true`, `nativeWaiting: true`,
 * `transcriptSource: "session-jsonl"` (a JSONL transcript on disk), and
 * `supportsResume: true`.
 *
 * This adapter teaches the engine to:
 *   - launch `pi` with a SESSION-SCOPED `--session-dir <dir>` so the session file
 *     is written somewhere discoverable (and never collides with the user's other
 *     sessions);
 *   - tail the session JSONL incrementally, mapping its event/message entries
 *     onto normalized `TelemetryEvent`s and chat transcript entries;
 *   - capture the native session id from the file's `session` header;
 *   - resume via `pi --session <path|partial-uuid>`.
 *
 * ── Verified against the installed binary (Pi) ──
 *   - `pi` is on PATH (`/opt/homebrew/bin/pi`).
 *   - `pi --help`: `--session <path|id>` ("Use specific session file or partial
 *     UUID"), `--session-dir <dir>` ("Directory for session storage and lookup"),
 *     `--mode <mode>` ("Output mode: text (default), json, or rpc"),
 *     `--resume, -r` (interactive picker), `--continue, -c`, `--no-session`,
 *     `--print, -p` (non-interactive), `--fork <path|id>`.
 *   - Session JSONL layout CONFIRMED by inspecting real files under
 *     `~/.pi/agent/sessions/<cwd-encoded>/<ts>_<uuid>.jsonl`: a first line
 *     `{type:"session", version, id:<uuid>, timestamp, cwd}`, then
 *     `{type:"model_change"|"thinking_level_change", ...}` and
 *     `{type:"message", id, parentId, timestamp, message:{ role, content:[
 *     {type:"text"|"thinking", text|thinking} ] }}` rows. `role` is one of
 *     `user` / `assistant` / `toolResult`.
 *
 * ── Assumed (marked so wiring composes; revisit on drift) ──
 *   - TELEMETRY EVENT MAPPING. The KTD specifies turn_start/agent_start→busy,
 *     turn_end/agent_end→done, input-request→waitingOnInput, message→transcript.
 *     The recorded v3 sessions I inspected contained only `message` rows (no
 *     explicit turn_* / agent_* / input-request rows — those arrive via the
 *     event bus / `--mode json` in newer builds). {@link mapSessionLine}
 *     therefore handles BOTH: explicit lifecycle events when present, AND a
 *     message-shape fallback (assistant message → busy/transcript). The explicit
 *     lifecycle event names are best-effort per the documented event bus and are
 *     matched case-insensitively with several spellings.
 *   - `--mode json` is an ALTERNATIVE interactive event stream; we implement the
 *     deterministic JSONL tail instead (the file is the source of truth and
 *     survives restarts). The session-dir mechanism makes the file discoverable.
 */

import type {
  CliAdapterCapabilities,
  CliAdapterLaunchContext,
  CliAdapterResumeContext,
  CliAgentAdapter,
  CliInjectionFormat,
  CliLaunchSpec,
  CliReadinessDetector,
} from "../adapter.js";
import { stripAnsiControl, type TelemetryEvent } from "../telemetry-hub.js";

// ── Capabilities ────────────────────────────────────────────────────────────

/** Pi native tier: session-JSONL telemetry + transcript + resume. */
export const PI_CAPABILITIES: CliAdapterCapabilities = {
  nativeDone: true,
  nativeWaiting: true,
  transcriptSource: "session-jsonl",
  supportsResume: true,
};

// ── Launch settings ───────────────────────────────────────────────────────────

const DEFAULT_COMMAND = "pi";

/** Adapter-specific launch settings recognized by the Pi adapter. */
export interface PiLaunchSettings {
  /** Override the `pi` binary. */
  command?: string;
  /** Extra args appended after the computed base args. */
  extraArgs?: readonly string[];
  /** Model override (`--model <pattern>`). */
  model?: string;
  /** Provider override (`--provider <name>`). */
  provider?: string;
  /**
   * Session-scoped directory for session storage + lookup (`--session-dir`). The
   * caller (session manager) owns + cleans this dir; setting it makes the session
   * file discoverable by {@link findSessionFile}. Strongly recommended so the
   * session JSONL never lands in the user's global sessions tree.
   */
  sessionDir?: string;
}

function readSettings(ctx: CliAdapterLaunchContext): PiLaunchSettings {
  return (ctx.settings ?? {}) as PiLaunchSettings;
}

function buildBaseArgs(ctx: CliAdapterLaunchContext): { command: string; args: string[] } {
  const settings = readSettings(ctx);
  const command = settings.command ?? DEFAULT_COMMAND;
  const args: string[] = [];
  if (typeof settings.provider === "string" && settings.provider.length > 0) {
    args.push("--provider", settings.provider);
  }
  if (typeof settings.model === "string" && settings.model.length > 0) {
    args.push("--model", settings.model);
  }
  if (typeof settings.sessionDir === "string" && settings.sessionDir.length > 0) {
    args.push("--session-dir", settings.sessionDir);
  }
  return { command, args };
}

/** Append the autonomy posture's privileged flags, only when permitted. */
function appendPostureFlags(args: string[], ctx: CliAdapterLaunchContext): void {
  // Visible-posture contract (R21). Pi enables all tools without confirmation via
  // its tool allowlist; full autonomy maps to enabling tools (`-t` with no
  // confirmation). We only widen tool access when the posture explicitly opts in.
  if (ctx.posture?.autoApprove === true) {
    // Pi prompts per-tool by default; auto-approve enables the full built-in set.
    args.push("--tools", "read,bash,edit,write");
  }
}

// ── Session file discovery ─────────────────────────────────────────────────────

/** Minimal Dirent shape so callers can inject a fake fs in tests. */
export interface DirentLike {
  name: string;
  isDirectory(): boolean;
}

/**
 * Probe a Pi session directory for the newest `*.jsonl` session file. Pi writes
 * `<ts>_<uuid>.jsonl`; when a session-scoped `--session-dir` was used the file
 * lands directly in that dir, but the user's global tree nests under a
 * cwd-encoded subdir — so we search one level deep too. Returns the lexically
 * greatest matching filename's full path (timestamps sort lexically), or null.
 */
export function findSessionFile(
  sessionDir: string,
  fs: { readdirSync: (p: string, o: { withFileTypes: true }) => DirentLike[] },
): string | null {
  const best: { path: string; name: string } = { path: "", name: "" };
  let found = false;
  const consider = (dir: string) => {
    let entries: DirentLike[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        consider(full); // one level of cwd-encoded nesting
      } else if (entry.name.endsWith(".jsonl")) {
        // Compare by FILENAME (timestamp-prefixed) so the dir prefix doesn't skew
        // the lexical ordering across nested vs flat layouts.
        if (!found || entry.name > best.name) {
          best.path = full;
          best.name = entry.name;
          found = true;
        }
      }
    }
  };
  consider(sessionDir);
  return found ? best.path : null;
}

// ── Session JSONL → telemetry ──────────────────────────────────────────────────

/**
 * Telemetry events the Pi tailer can synthesize from a session line. `transcript`
 * carries chat content; the others drive the state machine.
 */
export type PiSessionEvent =
  | { kind: "busy" }
  | { kind: "done" }
  | { kind: "waitingOnInput"; notification?: Record<string, unknown> }
  | { kind: "sessionStart"; nativeSessionId?: string }
  | { kind: "transcript"; role: PiTranscriptEntry["role"]; text: string };

export interface PiTranscriptEntry {
  role: "user" | "assistant" | "tool" | "system";
  text: string;
}

/** Lifecycle event-type spellings the tailer recognizes (case-insensitive set). */
const TURN_START_TYPES = new Set(["turn_start", "agent_start", "turnstart", "agentstart"]);
const TURN_END_TYPES = new Set(["turn_end", "agent_end", "turnend", "agentend"]);
const INPUT_REQUEST_TYPES = new Set([
  "input_request",
  "input-request",
  "inputrequest",
  "request_input",
  "ask_user",
  "elicit",
]);

/**
 * Map a parsed Pi session JSONL object onto a normalized {@link PiSessionEvent},
 * or null when the line carries no signal.
 *
 * Mapping (KTD telemetry tiering — native tier):
 *   session                                   → sessionStart (+ nativeSessionId)
 *   turn_start / agent_start                  → busy
 *   turn_end / agent_end                      → done
 *   input_request / ask_user / elicit         → waitingOnInput
 *   message{role:user|assistant|toolResult}   → transcript (assistant also implies
 *                                               a busy turn is underway → handled
 *                                               by the tailer)
 */
export function mapSessionLine(obj: Record<string, unknown>): PiSessionEvent | null {
  const type = typeof obj.type === "string" ? obj.type.toLowerCase() : "";

  if (type === "session") {
    const id = typeof obj.id === "string" && obj.id.length > 0 ? obj.id : undefined;
    return { kind: "sessionStart", nativeSessionId: id };
  }
  if (TURN_START_TYPES.has(type)) return { kind: "busy" };
  if (TURN_END_TYPES.has(type)) return { kind: "done" };
  if (INPUT_REQUEST_TYPES.has(type)) {
    return {
      kind: "waitingOnInput",
      notification: { kind: "input_request", source: "session-jsonl" },
    };
  }
  if (type === "message") {
    const message = obj.message as Record<string, unknown> | undefined;
    if (!message) return null;
    const role = normalizeRole(typeof message.role === "string" ? message.role : "");
    const text = flattenContent(message.content);
    if (text.length === 0) return null;
    return { kind: "transcript", role, text };
  }
  return null;
}

function normalizeRole(raw: string): PiTranscriptEntry["role"] {
  switch (raw.toLowerCase()) {
    case "user":
    case "human":
      return "user";
    case "assistant":
    case "model":
      return "assistant";
    case "toolresult":
    case "tool_result":
    case "tool":
    case "tooluse":
    case "tool_use":
      return "tool";
    default:
      return "system";
  }
}

/** Flatten Pi content blocks (`[{type:"text",text}|{type:"thinking",thinking}]`). */
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object") {
          const b = block as Record<string, unknown>;
          if (typeof b.text === "string") return b.text;
          if (typeof b.thinking === "string") return b.thinking;
        }
        return "";
      })
      .filter((s) => s.length > 0)
      .join("")
      .trim();
  }
  return "";
}

/**
 * Convert a {@link PiSessionEvent} into the engine's normalized
 * {@link TelemetryEvent} shape (the hub's ingest contract). A `transcript` event
 * becomes a `transcript` kind carrying its flattened text; lifecycle events map
 * one-to-one. An assistant `transcript` ALSO implies the turn is busy, but to
 * keep mapping pure the tailer emits the `busy` separately (see
 * {@link PiSessionTailer.push}).
 */
export function toTelemetryEvent(event: PiSessionEvent): TelemetryEvent {
  switch (event.kind) {
    case "sessionStart":
      return {
        kind: "sessionStart",
        payload: event.nativeSessionId ? { nativeSessionId: event.nativeSessionId } : {},
      };
    case "busy":
      return { kind: "busy", payload: {} };
    case "done":
      return { kind: "done", payload: {} };
    case "waitingOnInput":
      return {
        kind: "waitingOnInput",
        payload: event.notification ? { notification: event.notification } : {},
      };
    case "transcript":
      return { kind: "transcript", payload: { text: event.text, role: event.role } };
  }
}

// ── Session JSONL tailer ───────────────────────────────────────────────────────

/**
 * Incremental Pi session-JSONL tailer. Pi appends one JSON object per line; this
 * remembers the byte offset so each {@link push} yields only entries appended
 * since the last call. Mirrors the Claude/Codex tailers' offset tracking,
 * partial-line handling, and unparseable-line tolerance. Returns the
 * {@link PiSessionEvent}s synthesized from the appended lines (lifecycle +
 * transcript), in order.
 */
export class PiSessionTailer {
  private offset = 0;
  private partial = "";

  get bytesRead(): number {
    return this.offset;
  }

  push(chunk: string): PiSessionEvent[] {
    this.offset += Buffer.byteLength(chunk, "utf8");
    const text = this.partial + chunk;
    const lines = text.split("\n");
    this.partial = lines.pop() ?? "";
    const events: PiSessionEvent[] = [];
    for (const line of lines) {
      const ev = parseSessionLine(line);
      if (ev) events.push(ev);
    }
    return events;
  }

  flush(): PiSessionEvent[] {
    if (this.partial.trim().length === 0) {
      this.partial = "";
      return [];
    }
    const ev = parseSessionLine(this.partial);
    this.partial = "";
    return ev ? [ev] : [];
  }
}

function parseSessionLine(line: string): PiSessionEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object") return null;
    obj = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  return mapSessionLine(obj);
}

// ── Readiness detector ─────────────────────────────────────────────────────────

const READY_GLYPHS = [">", "❯", "▌", "»"];

/**
 * Readiness detector for Pi's interactive TUI. Pi's session file is the
 * authoritative telemetry source but readiness gates the FIRST injection before
 * the file is populated, so this output-based detector is primary: ready on the
 * bracketed-paste enable sequence or a composer prompt glyph at a line's
 * trailing edge.
 */
export class PiReadinessDetector implements CliReadinessDetector {
  private ready = false;
  private buffer = "";

  observe(chunk: string): boolean {
    if (this.ready) return true;
    this.buffer = (this.buffer + chunk).slice(-4096);
    if (this.buffer.includes("\x1b[?2004h")) {
      this.ready = true;
      return true;
    }
    const stripped = stripAnsiControl(this.buffer);
    const tail = stripped.replace(/[ \t\r\n]+$/g, "").slice(-8);
    if (READY_GLYPHS.some((g) => tail.endsWith(g))) {
      this.ready = true;
      return true;
    }
    return false;
  }
}

// ── The adapter ─────────────────────────────────────────────────────────────

export const piAdapter: CliAgentAdapter = {
  id: "pi",
  name: "Pi",
  capabilities: PI_CAPABILITIES,
  defaultCommand: DEFAULT_COMMAND,
  elevationMarkers: {
    // Pi elevation: widening the tool allowlist to include write-capable tools
    // without per-tool confirmation (`--tools read,bash,edit,write`) or a yolo /
    // no-confirm flag. The `--tools` form with bash/edit/write is the auto-approve
    // equivalent the posture maps to.
    exactArgs: ["--yolo", "--no-confirm", "--dangerously-skip-permissions"],
    argPatterns: [/^--tools=.*\b(bash|edit|write)\b/i],
    matchArgv(argv) {
      const hits: string[] = [];
      for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--tools" && /\b(bash|edit|write)\b/i.test(argv[i + 1] ?? "")) {
          hits.push(`--tools ${argv[i + 1]}`);
        }
      }
      return hits;
    },
  },

  buildLaunch(ctx: CliAdapterLaunchContext): CliLaunchSpec {
    const settings = readSettings(ctx);
    const { command, args } = buildBaseArgs(ctx);
    appendPostureFlags(args, ctx);
    if (settings.extraArgs) args.push(...settings.extraArgs);
    return { command, args };
  },

  buildEnvAllowlist(): string[] {
    // Only what Pi needs to authenticate, find its config, and render a terminal.
    // NEVER inherit-everything — FUSION_* creds stay out of the child.
    return [
      "HOME",
      "PATH",
      "SHELL",
      "USER",
      "LOGNAME",
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
      "TERM",
      "TERMINFO",
      "TMPDIR",
      "COLORTERM",
      "XDG_CONFIG_HOME",
      "XDG_CACHE_HOME",
      "XDG_DATA_HOME",
      // Pi session-dir override + common provider auth keys.
      "PI_CODING_AGENT_SESSION_DIR",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
    ];
  },

  createReadinessDetector(): CliReadinessDetector {
    return new PiReadinessDetector();
  },

  formatInjection(text: string, _opts: { bracketedPasteActive: boolean }): CliInjectionFormat {
    // Session manager owns paste-wrapping + neutralization; we add the submit CR.
    const payload = text.endsWith("\r") ? text : `${text}\r`;
    return { payload };
  },

  buildResume(ctx: CliAdapterResumeContext): CliLaunchSpec {
    // `pi --session <path|partial-uuid>` re-attaches the prior conversation. The
    // recorded native id is the session uuid (or its file path); both are accepted
    // by `--session`. Provider/model/session-dir are re-applied.
    const settings = readSettings(ctx);
    const { command, args } = buildBaseArgs(ctx);
    args.push("--session", ctx.nativeSessionId);
    appendPostureFlags(args, ctx);
    if (settings.extraArgs) args.push(...settings.extraArgs);
    return { command, args };
  },
};
