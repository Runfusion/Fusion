/**
 * Codex adapter — HYBRID-tier CliAgentAdapter (U5).
 *
 * Codex is the hybrid tier: it has a NATIVE turn-complete signal (via its
 * `notify` config program) and a structured rollout transcript on disk, but NO
 * native waiting-on-input signal. Waiting-on-input is therefore inferred from
 * the PTY byte stream with Codex-specific prompt-pattern heuristics (composed on
 * top of the same ANSI-stripping the generic adapter uses). The capability flags
 * advertise this honestly: `nativeDone: true`, `nativeWaiting: false`.
 *
 * This adapter teaches the engine to:
 *   - launch `codex` with a SESSION-SCOPED notify program so a turn-complete
 *     event reaches the engine without touching the user's `~/.codex/config.toml`
 *     (mechanism below);
 *   - normalize the notify JSON payload → a `done` `TelemetryEvent`, capturing
 *     `thread-id` as the native session id;
 *   - detect waiting-on-input via {@link CodexWaitingAnalyzer} (heuristic — see
 *     the per-method docs; this is the hybrid-tier fallback, NOT a native signal);
 *   - tail the rollout JSONL transcript incrementally (probing the sessions dir,
 *     never hardcoding the layout — it is version-sensitive);
 *   - resume via `codex resume <thread-id>`.
 *
 * ── Verified against the installed binary (Codex 0.128.0, arm64) ──
 *   - `codex` is on PATH; `~/.codex/` is the default `CODEX_HOME`.
 *   - Rollout JSONL layout CONFIRMED by inspecting real files:
 *       `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<thread-id>.jsonl`
 *     with a first line `{type:"session_meta", payload:{ id:<thread-id>, cwd,
 *     originator, cli_version, ... }}`, then `{type:"event_msg", payload:{
 *     type:"task_started", turn_id, ... }}`, then `{type:"response_item",
 *     payload:{ type:"message", role, content:[{type,text}] }}` lines. The
 *     `thread-id` IS the `session_meta.payload.id` and is embedded in the
 *     filename. We PROBE for the file by thread-id (see {@link findRolloutPath}),
 *     never assuming the date path.
 *   - `codex resume` and `codex exec` subcommands exist (`codex --help`); the
 *     interactive `--help` for subcommands could not be captured in this sandbox
 *     (the binary opens a TUI), so the exact resume arg shape below is per the
 *     documented public interface: `codex resume <thread-id>` and the `-c
 *     key=value` config-override flag.
 *
 * ── Assumed / mechanism choice (marked so wiring composes; revisit on drift) ──
 *   - NOTIFY MECHANISM. Codex's documented native turn-complete is the `notify`
 *     config key: `notify = ["<program>", ...args]`. Codex invokes that program
 *     with a single JSON-string argument `{ type:"agent-turn-complete",
 *     "thread-id":…, "turn-id":…, cwd:…, "last-assistant-message":… }`. Two
 *     session-scoped delivery options exist; we choose **`-c notify=[...]`
 *     config-override on the launch argv** as the PRIMARY mechanism (it is
 *     session-scoped by construction and never mutates the user's config), and
 *     expose a **layered `CODEX_HOME`** fallback for callers that prefer a
 *     scratch config dir. See {@link buildNotifyOverrideArg} and
 *     {@link codexSessionHomeLayout}. The notify PROGRAM itself (the shim that
 *     forwards the payload to the engine telemetry hub) is produced by the U17
 *     hook-scripts module; this adapter only references its path.
 *   - The notify payload uses hyphenated keys (`thread-id`, `turn-id`,
 *     `last-assistant-message`) per the documented schema; {@link mapNotifyPayload}
 *     also tolerates the snake_case / camelCase variants in case a version drifts.
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

/**
 * Codex hybrid tier: native done (notify) + rollout transcript + resume, but NO
 * native waiting-on-input (heuristic PTY detection instead).
 */
export const CODEX_CAPABILITIES: CliAdapterCapabilities = {
  nativeDone: true,
  nativeWaiting: false,
  transcriptSource: "jsonl",
  supportsResume: true,
};

// ── Launch settings ───────────────────────────────────────────────────────────

const DEFAULT_COMMAND = "codex";

/**
 * Adapter-specific launch settings recognized by the Codex adapter. All optional
 * so a bare `codex` still launches without telemetry wiring.
 */
export interface CodexLaunchSettings {
  /** Override the `codex` binary. */
  command?: string;
  /** Extra args appended after the computed base args. */
  extraArgs?: readonly string[];
  /** Model override (`-c model=<id>`). */
  model?: string;
  /**
   * Absolute path to the session-scoped notify program (from U17). When present
   * the adapter appends `-c notify=["<path>"]` so a turn-complete event is
   * delivered session-scoped without touching the user's config.
   */
  notifyProgram?: string;
  /**
   * Optional layered `CODEX_HOME` directory for callers that prefer a scratch
   * config dir over the `-c` override (see {@link codexSessionHomeLayout}). When
   * set, it is surfaced via the env allowlist and the caller is responsible for
   * materializing the dir; the adapter does not write it.
   */
  codexHome?: string;
  /**
   * Override the sessions root the rollout tailer probes. Defaults to
   * `<CODEX_HOME>/sessions`. The exact dated sub-layout is probed, never assumed.
   */
  sessionsDir?: string;
}

function readSettings(ctx: CliAdapterLaunchContext): CodexLaunchSettings {
  return (ctx.settings ?? {}) as CodexLaunchSettings;
}

/**
 * Build the `-c notify=[...]` config-override token vector for a session-scoped
 * notify program. Codex's `-c key=value` flag takes a TOML-ish value; an array
 * of one program path is `["<path>"]`. Returns the two argv tokens (`-c` and the
 * `notify=[...]` assignment) or an empty array when no program is configured.
 */
export function buildNotifyOverrideArg(notifyProgram: string | undefined): string[] {
  if (!notifyProgram || notifyProgram.trim().length === 0) return [];
  // JSON array literal is valid TOML array syntax for a single string element.
  const value = JSON.stringify([notifyProgram]);
  return ["-c", `notify=${value}`];
}

/**
 * Describe the layered session-scoped `CODEX_HOME` mechanism (the alternative to
 * `-c notify`). The caller materializes `dir` (copying/symlinking the user's
 * `auth.json` so the child stays authenticated) and writes a `config.toml` that
 * sets `notify`. This adapter only computes the intended layout for the caller;
 * it performs NO filesystem writes (containment + lifecycle is the session
 * manager's job, mirroring the Claude adapter's settings-file contract).
 */
export function codexSessionHomeLayout(dir: string): {
  home: string;
  configPath: string;
  authPath: string;
} {
  return {
    home: dir,
    configPath: `${dir}/config.toml`,
    authPath: `${dir}/auth.json`,
  };
}

function buildBaseArgs(ctx: CliAdapterLaunchContext): { command: string; args: string[] } {
  const settings = readSettings(ctx);
  const command = settings.command ?? DEFAULT_COMMAND;
  const args: string[] = [];
  if (typeof settings.model === "string" && settings.model.length > 0) {
    // Model is set via a config override so it composes with `-c notify`.
    args.push("-c", `model=${JSON.stringify(settings.model)}`);
  }
  args.push(...buildNotifyOverrideArg(settings.notifyProgram));
  return { command, args };
}

/** Append the autonomy posture's privileged flags, only when permitted. */
function appendPostureFlags(args: string[], ctx: CliAdapterLaunchContext): void {
  // Visible-posture contract (R21): only emit the dangerous bypass when the
  // posture explicitly opts in. Codex's full-access sandbox bypass.
  if (ctx.posture?.autoApprove === true) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }
}

// ── Notify payload → telemetry ─────────────────────────────────────────────────

/**
 * The raw Codex notify payload (delivered as a JSON string argument to the
 * notify program). Documented keys are hyphenated; we tolerate snake/camel too.
 */
export interface CodexNotifyPayload {
  type?: string;
  "thread-id"?: string;
  thread_id?: string;
  threadId?: string;
  "turn-id"?: string;
  turn_id?: string;
  turnId?: string;
  cwd?: string;
  "last-assistant-message"?: string;
  last_assistant_message?: string;
  lastAssistantMessage?: string;
  [key: string]: unknown;
}

/** Read the first present of several key spellings off a payload. */
function pick(payload: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Map a Codex notify payload onto a normalized `TelemetryEvent`. The only Codex
 * notify event we act on is `agent-turn-complete` → `done`, capturing the
 * `thread-id` as the native session id. Returns null for any other / malformed
 * payload (telemetry is best-effort).
 *
 * Mapping (KTD telemetry tiering — hybrid tier):
 *   notify{agent-turn-complete} → done (+ nativeSessionId = thread-id)
 */
export function mapNotifyPayload(payload: CodexNotifyPayload): TelemetryEvent | null {
  const type = typeof payload.type === "string" ? payload.type : "";
  if (type !== "agent-turn-complete") return null;
  const threadId = pick(payload, ["thread-id", "thread_id", "threadId"]);
  const turnId = pick(payload, ["turn-id", "turn_id", "turnId"]);
  const lastMessage = pick(payload, [
    "last-assistant-message",
    "last_assistant_message",
    "lastAssistantMessage",
  ]);
  const out: TelemetryEvent = { kind: "done", payload: {} };
  if (threadId) out.payload!.nativeSessionId = threadId;
  if (turnId) out.payload!.turnId = turnId;
  if (typeof lastMessage === "string") out.payload!.lastAssistantMessage = lastMessage;
  if (typeof payload.cwd === "string") out.payload!.cwd = payload.cwd;
  return out;
}

/**
 * Parse the raw notify argument (the JSON string Codex passes to the notify
 * program) into a normalized event. Returns null on unparseable input — never
 * throws at the ingestion boundary.
 */
export function parseNotifyPayload(raw: string): TelemetryEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  return mapNotifyPayload(parsed as CodexNotifyPayload);
}

// ── Waiting-on-input heuristics (hybrid-tier fallback — NOT native) ───────────

/**
 * Codex-specific prompt patterns that indicate the agent is blocked waiting on a
 * human. HEURISTIC (hybrid tier): Codex has no native waiting-on-input signal,
 * so we infer it from ANSI-stripped PTY output. These patterns are intentionally
 * conservative — a false positive only adds a needs-input affordance, never
 * advances the pipeline.
 *
 * - Approval prompt menus Codex draws when a command/patch needs approval
 *   ("Allow", "Approve", "y/n", numbered "1. Yes / 2. No" menus).
 * - The idle "ready for input" marker Codex shows at the bottom of the composer
 *   ("enter to send", "Ctrl+J newline", etc.).
 */
// Single-line approval patterns are matched against the LAST non-empty line
// only (which IS the trailing edge), so a stale prompt earlier in scrollback
// stops matching once fresh output renders below it — this is what makes the
// heuristic re-arm correctly.
const SINGLE_LINE_APPROVAL_PATTERNS: RegExp[] = [
  // Approval prompt verbs + a yes/no affordance on one line.
  /\b(allow|approve|apply (?:this )?(?:patch|change|command)|run (?:this )?command)\b.{0,80}\b(y\s*\/\s*n|yes\s*\/\s*no)\b/i,
  // Bare yes/no prompt.
  /\b(y\s*\/\s*n|yes\s*\/\s*no)\s*[?:]?\s*$/i,
  // Explicit "waiting for approval" wording.
  /\b(waiting for (?:your )?approval|requires (?:your )?approval|needs (?:your )?approval)\b/i,
];

// The numbered approval menu (1. Yes … 2. No …) legitimately spans lines; it is
// checked against the last few lines and anchored to the trailing edge.
const CODEX_NUMBERED_MENU_PATTERN =
  /(^|\n)\s*1[.)]\s*(yes|approve|allow)[\s\S]{0,80}\n\s*2[.)]\s*(no|reject|deny)[\s\S]{0,40}$/i;

/** Idle "ready for input" composer markers (matched against the last line). */
const CODEX_IDLE_MARKERS: RegExp[] = [
  /\benter to send\b/i,
  /\bpress enter\b/i,
  /\bsend a message\b/i,
];

/**
 * Spinner / working markers Codex shows while busy. When one of these is present
 * at the trailing edge the waiting heuristic is OVERRIDDEN (the agent is working,
 * not waiting), mirroring the generic analyzer's spinner-override rule.
 */
const CODEX_WORKING_PATTERN = /\b(working|thinking|executing|running|esc to interrupt)\b/i;

/** Max trailing chars of the stripped window inspected for prompt patterns. */
const CODEX_WINDOW_CHARS = 4_096;

/**
 * Stateful waiting-on-input analyzer for Codex (hybrid-tier heuristic). Fed
 * ANSI-bearing PTY output via {@link observe}; emits a `waitingOnInput`
 * `TelemetryEvent` once when an approval/idle prompt is detected at the trailing
 * edge and no working marker overrides it. De-dupes (re-arms when fresh non-
 * prompt output arrives).
 *
 * This is the explicitly-marked HEURISTIC fallback for the hybrid tier — Codex
 * exposes no native waiting signal (`nativeWaiting: false`).
 */
export class CodexWaitingAnalyzer {
  private readonly emit: (event: TelemetryEvent) => void;
  private window = "";
  private waitingEmitted = false;

  constructor(opts: { emit: (event: TelemetryEvent) => void }) {
    this.emit = opts.emit;
  }

  /** Observe a raw (ANSI-bearing) output chunk. */
  observe(rawChunk: string): void {
    const stripped = stripAnsiControl(rawChunk);
    if (stripped.length === 0) return;
    this.window = (this.window + stripped).slice(-CODEX_WINDOW_CHARS);

    // Working marker overrides any prompt detection: the agent is busy.
    if (CODEX_WORKING_PATTERN.test(this.trailingChunk())) {
      this.waitingEmitted = false;
      return;
    }

    if (this.isWaiting()) {
      if (!this.waitingEmitted) {
        this.waitingEmitted = true;
        this.emit({
          kind: "waitingOnInput",
          payload: {
            notification: { kind: this.classify(), source: "heuristic" },
          },
        });
      }
      return;
    }
    // Fresh non-prompt output → re-arm so a later prompt re-emits.
    this.waitingEmitted = false;
  }

  /**
   * Whether the trailing window currently looks like a waiting prompt. Single-
   * line prompts (verb+yn, bare yn, idle markers, "waiting for approval") are
   * checked against the LAST non-empty line ONLY — so a stale prompt earlier in
   * scrollback stops matching once fresh output renders below it (this is what
   * makes the de-dupe re-arm correct). The multi-line numbered menu is checked
   * against the last few lines (it legitimately spans lines) and is anchored to
   * the trailing edge.
   */
  isWaiting(): boolean {
    return this.matchedSubReason() !== null;
  }

  /** Sub-reason tag for the notification (approval vs idle prompt). */
  private classify(): string {
    return this.matchedSubReason() ?? "idle_prompt";
  }

  /** The matched sub-reason at the trailing edge, or null when not waiting. */
  private matchedSubReason(): "approval_prompt" | "idle_prompt" | null {
    const lastLine = this.lastNonEmptyLine();
    const menuTail = this.trailingLines(4);
    if (
      SINGLE_LINE_APPROVAL_PATTERNS.some((re) => re.test(lastLine)) ||
      CODEX_NUMBERED_MENU_PATTERN.test(menuTail)
    ) {
      return "approval_prompt";
    }
    if (CODEX_IDLE_MARKERS.some((re) => re.test(lastLine))) return "idle_prompt";
    return null;
  }

  /** The last non-empty line of the window (whitespace-trimmed at the end). */
  private lastNonEmptyLine(): string {
    const lines = this.window.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim().length > 0) return lines[i].trimEnd();
    }
    return "";
  }

  /** The last `n` non-empty lines joined (for the multi-line menu check). */
  private trailingLines(n: number): string {
    const lines = this.window.split(/\r?\n/).filter((l) => l.trim().length > 0);
    return lines.slice(-n).join("\n");
  }

  /** Working-marker override is checked against the trailing few lines. */
  private trailingChunk(): string {
    return this.trailingLines(4);
  }
}

// ── Rollout transcript tailing ─────────────────────────────────────────────────

/** A normalized transcript entry surfaced to chat. */
export interface CodexTranscriptEntry {
  role: "user" | "assistant" | "tool" | "system";
  text: string;
}

/**
 * Probe the Codex sessions directory for the rollout file matching a thread-id.
 * The layout (`<sessionsDir>/YYYY/MM/DD/rollout-<ts>-<thread-id>.jsonl`) is
 * version-sensitive (community-sourced), so we DO NOT hardcode the dated path —
 * we recursively search for a `rollout-*<thread-id>*.jsonl` file. Returns the
 * first match or null. Tolerant of a missing dir.
 */
export function findRolloutPath(
  sessionsDir: string,
  threadId: string,
  fs: { readdirSync: (p: string, o: { withFileTypes: true }) => DirentLike[] },
): string | null {
  const stack: string[] = [sessionsDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: DirentLike[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // missing / unreadable dir → skip
    }
    for (const entry of entries) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (
        entry.name.startsWith("rollout-") &&
        entry.name.endsWith(".jsonl") &&
        entry.name.includes(threadId)
      ) {
        return full;
      }
    }
  }
  return null;
}

/** Minimal Dirent shape (so callers can inject a fake fs in tests). */
export interface DirentLike {
  name: string;
  isDirectory(): boolean;
}

/**
 * Incremental rollout JSONL tailer. Codex appends one JSON object per line; this
 * remembers the byte offset so each {@link push} yields only entries appended
 * since the last call. Mirrors {@link ClaudeTranscriptTailer}'s partial-line and
 * unparseable-line tolerance. Only `response_item` message rows become chat
 * entries; meta / event rows are skipped.
 */
export class CodexRolloutTailer {
  private offset = 0;
  private partial = "";

  get bytesRead(): number {
    return this.offset;
  }

  push(chunk: string): CodexTranscriptEntry[] {
    this.offset += Buffer.byteLength(chunk, "utf8");
    const text = this.partial + chunk;
    const lines = text.split("\n");
    this.partial = lines.pop() ?? "";
    const entries: CodexTranscriptEntry[] = [];
    for (const line of lines) {
      const entry = parseRolloutLine(line);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  flush(): CodexTranscriptEntry[] {
    if (this.partial.trim().length === 0) {
      this.partial = "";
      return [];
    }
    const entry = parseRolloutLine(this.partial);
    this.partial = "";
    return entry ? [entry] : [];
  }
}

/** Parse a single rollout JSONL line into a normalized entry, or null. */
function parseRolloutLine(line: string): CodexTranscriptEntry | null {
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
  // Only `response_item` rows carrying a `message` payload are chat content.
  if (obj.type !== "response_item") return null;
  const payload = obj.payload as Record<string, unknown> | undefined;
  if (!payload || payload.type !== "message") return null;
  const role = normalizeRole(typeof payload.role === "string" ? payload.role : "");
  const text = flattenContent(payload.content);
  if (text.length === 0) return null;
  return { role, text };
}

function normalizeRole(raw: string): CodexTranscriptEntry["role"] {
  switch (raw) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "tool":
      return "tool";
    // `developer` / `system` instructions render as system.
    default:
      return "system";
  }
}

/** Flatten Codex content blocks (`[{type:"input_text"|"output_text", text}]`). */
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object") {
          const b = block as Record<string, unknown>;
          if (typeof b.text === "string") return b.text;
        }
        return "";
      })
      .filter((s) => s.length > 0)
      .join("")
      .trim();
  }
  return "";
}

// ── Readiness detector ─────────────────────────────────────────────────────────

/** Prompt-like trailing glyphs that suggest Codex's composer is ready. */
const READY_GLYPHS = [">", "❯", "▌", "│"];

/**
 * Readiness detector for Codex's interactive TUI. Native readiness has no hook
 * (Codex's hybrid tier only natively signals done), so this output-based
 * detector is the primary readiness signal: ready on the bracketed-paste enable
 * sequence (the editor mounted) or a composer prompt glyph at a line's trailing
 * edge. Tolerant of partial chunks (keeps a bounded tail).
 */
export class CodexReadinessDetector implements CliReadinessDetector {
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

export const codexAdapter: CliAgentAdapter = {
  id: "codex",
  name: "Codex",
  capabilities: CODEX_CAPABILITIES,
  defaultCommand: DEFAULT_COMMAND,
  elevationMarkers: {
    // Codex elevation: the sandbox/approval bypass flag, `--full-auto`/`--yolo`
    // shorthands, and `-c approval_policy=...` / `-c sandbox=...` config overrides.
    exactArgs: [
      "--dangerously-bypass-approvals-and-sandbox",
      "--full-auto",
      "--yolo",
    ],
    argPatterns: [
      /^-c\s*approval_policy=/i,
      /^approval_policy=/i,
      /^-c\s*sandbox(_mode)?=/i,
      /^sandbox(_mode)?=/i,
    ],
    matchArgv(argv) {
      const hits: string[] = [];
      for (let i = 0; i < argv.length; i++) {
        // `-c approval_policy=...` (or sandbox=...) passed as two tokens.
        if (argv[i] === "-c" && typeof argv[i + 1] === "string") {
          const v = argv[i + 1];
          if (/^(approval_policy|sandbox|sandbox_mode)=/i.test(v)) {
            hits.push(`-c ${v}`);
          }
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

  buildEnvAllowlist(ctx: CliAdapterLaunchContext): string[] {
    const settings = readSettings(ctx);
    // Only what Codex needs to authenticate, find its config, and render a
    // terminal. NEVER inherit-everything — FUSION_* creds stay out of the child.
    const base = [
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
      // Codex config home + auth.
      "CODEX_HOME",
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
    ];
    // When a layered CODEX_HOME scratch dir is configured the env carries it.
    return settings.codexHome ? [...new Set([...base, "CODEX_HOME"])] : base;
  },

  createReadinessDetector(): CliReadinessDetector {
    return new CodexReadinessDetector();
  },

  formatInjection(text: string, _opts: { bracketedPasteActive: boolean }): CliInjectionFormat {
    // The session manager owns bracketed-paste wrapping and control-char
    // neutralization. This hook only adds the trailing submit CR.
    const payload = text.endsWith("\r") ? text : `${text}\r`;
    return { payload };
  },

  buildResume(ctx: CliAdapterResumeContext): CliLaunchSpec {
    // `codex resume <thread-id>` re-attaches the prior conversation. The notify
    // override + model are re-applied so the resumed session keeps telemetry
    // wiring. (The `resume` subcommand precedes the thread-id and config flags.)
    const settings = readSettings(ctx);
    const command = settings.command ?? DEFAULT_COMMAND;
    const args: string[] = ["resume", ctx.nativeSessionId];
    if (typeof settings.model === "string" && settings.model.length > 0) {
      args.push("-c", `model=${JSON.stringify(settings.model)}`);
    }
    args.push(...buildNotifyOverrideArg(settings.notifyProgram));
    appendPostureFlags(args, ctx);
    if (settings.extraArgs) args.push(...settings.extraArgs);
    return { command, args };
  },
};
