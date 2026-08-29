/**
 * Claude Code adapter — the reference native-tier CliAgentAdapter (U4).
 *
 * Claude Code exposes the richest native telemetry of the four launch agents:
 * a full hook roster (`SessionStart`, `PreToolUse`/`PostToolUse`,
 * `UserPromptSubmit`, `Notification`, `PermissionRequest`, `Stop`) that each
 * deliver a JSON payload (`hook_event_name`, `session_id`, `transcript_path`,
 * `source`, `notification_type`, …) on the hook command's stdin, plus a JSONL
 * transcript on disk. This adapter teaches the engine to:
 *   - launch `claude` with a SESSION-SCOPED additional settings file that
 *     registers those hooks pointing at this session's hook script (so we never
 *     touch the user's global `~/.claude` or the repo's tracked `.claude/`);
 *   - normalize raw hook payloads → engine `TelemetryEvent`s;
 *   - tail the JSONL transcript incrementally for chat;
 *   - resume via `claude --resume <session-id>`.
 *
 * ── Verified against the installed binary (Claude Code 2.1.165, arm64) ──
 * The following were confirmed by probing the shipped binary, not assumed:
 *   - CLI flags: `--settings <file-or-json>` (additional settings), `--resume`
 *     / `-r [value]` (resume by session id), `--session-id <uuid>`,
 *     `--setting-sources`, `-p/--print` (non-interactive).  [`claude --help`]
 *   - Hook event names present in the binary: `SessionStart`, `PreToolUse`,
 *     `PostToolUse`, `UserPromptSubmit`, `Notification`, `PermissionRequest`,
 *     `Stop`, `SubagentStop`, `PreCompact`, `SessionEnd`.
 *   - Payload field names present: `hook_event_name`, `session_id`,
 *     `transcript_path`, `notification_type`, plus notification kinds
 *     `permission_prompt` / `idle_prompt`, and SessionStart `source` enum
 *     values `startup` / `resume` / `clear` / `compact`.
 *   - Settings hook schema shape (from the binary's embedded docs):
 *       { "hooks": { "<EventName>": [ { "matcher": "...",
 *           "hooks": [ { "type": "command", "command": "<script>" } ] } ] } }
 *     The hook command receives the event payload as JSON on stdin.
 *
 * ── Assumed (marked so wiring composes; revisit if a version drifts) ──
 *   - The session-scoped hook SCRIPT itself is produced by the U17 hook-scripts
 *     module. That module does not exist in this worktree yet, so this adapter
 *     accepts the already-written script paths via `HookScriptRefs` on the
 *     launch settings (see `claudeCodeSettings`). The adapter only emits the
 *     settings JSON that references them.
 *   - `Stop` carries no machine-readable success/failure flag in the payload we
 *     can rely on across versions; we map `Stop` → `done` (positive completion)
 *     and expose `classifyStop` so a caller can downgrade to an error-ish event
 *     when it has out-of-band failure evidence (e.g. `stop_reason`).
 */

import { writeFileSync } from "node:fs";
import type {
  CliAdapterCapabilities,
  CliAdapterLaunchContext,
  CliAdapterResumeContext,
  CliAgentAdapter,
  CliInjectionFormat,
  CliLaunchSpec,
  CliReadinessDetector,
} from "../adapter.js";
import type { TelemetryEvent } from "../telemetry-hub.js";

// ── Capabilities ────────────────────────────────────────────────────────────

/** Claude Code is the fully native tier: hooks + JSONL transcript + resume. */
export const CLAUDE_CODE_CAPABILITIES: CliAdapterCapabilities = {
  nativeDone: true,
  nativeWaiting: true,
  transcriptSource: "jsonl",
  supportsResume: true,
};

// ── Hook script references (U17 seam) ─────────────────────────────────────────

/**
 * Paths to the session-scoped hook scripts the U17 hook-scripts module writes.
 * The adapter does NOT create these scripts — it only references them from the
 * generated settings JSON. Until U17 lands, a caller passes the paths directly
 * (one script may back several events, or each event its own script).
 */
export interface HookScriptRefs {
  /** Script for the `Stop` hook (positive completion). */
  stopScript: string;
  /** Script for the `Notification` hook (permission_prompt / idle_prompt). */
  notificationScript: string;
  /** Script for the `PermissionRequest` hook (waiting-on-input). */
  permissionScript: string;
  /** Script for the `SessionStart` hook (captures session_id / source). */
  sessionStartScript: string;
  /** Optional script for tool-activity hooks (PreToolUse/PostToolUse/UserPromptSubmit). */
  toolActivityScript?: string;
}

/**
 * Adapter-specific launch settings recognized by this adapter. These ride on the
 * open `CliAdapterLaunchSettings` (`ctx.settings`). All optional so a generic
 * spawn without hook wiring still launches a bare `claude`.
 */
export interface ClaudeCodeLaunchSettings {
  /** Override the `claude` binary. */
  command?: string;
  /** Extra args appended after the computed base args. */
  extraArgs?: readonly string[];
  /** Model override (`--model <id>`). */
  model?: string;
  /** Session-scoped hook script paths (from U17). */
  hookScripts?: HookScriptRefs;
  /**
   * Absolute path the adapter should WRITE the session-scoped settings JSON to.
   * MUST live under the session's scratch dir — never the user's global
   * `~/.claude` nor the repo's tracked `.claude/`. The caller (session manager /
   * task-session) owns the dir and deletes it on session end (U17 lifecycle).
   * When absent the adapter emits the settings inline as a JSON string via
   * `--settings <json>` (still session-scoped — no file written).
   */
  settingsPath?: string;
}

// ── Settings JSON generation ──────────────────────────────────────────────────

/** One hook entry in Claude Code's settings schema. */
interface HookCommandEntry {
  matcher?: string;
  hooks: { type: "command"; command: string }[];
}

/** The `hooks` block of a Claude Code settings file. */
export interface ClaudeCodeHooksConfig {
  [eventName: string]: HookCommandEntry[];
}

/** A minimal session-scoped Claude Code settings document. */
export interface ClaudeCodeSettings {
  hooks: ClaudeCodeHooksConfig;
}

/**
 * Build the session-scoped Claude Code settings document that registers our
 * hooks. Shape verified against the binary's embedded settings docs:
 *   { hooks: { EventName: [{ matcher?, hooks: [{ type: "command", command }] }] } }
 *
 * Tool-activity events (PreToolUse/PostToolUse/UserPromptSubmit) are registered
 * only when a `toolActivityScript` is supplied — they re-arm the inactivity
 * watchdog but are not required for the core ready→busy→done flow.
 */
export function buildClaudeCodeSettings(scripts: HookScriptRefs): ClaudeCodeSettings {
  const cmd = (command: string): HookCommandEntry => ({
    hooks: [{ type: "command", command }],
  });
  const hooks: ClaudeCodeHooksConfig = {
    SessionStart: [cmd(scripts.sessionStartScript)],
    Stop: [cmd(scripts.stopScript)],
    Notification: [cmd(scripts.notificationScript)],
    PermissionRequest: [cmd(scripts.permissionScript)],
  };
  if (scripts.toolActivityScript) {
    const activity = [cmd(scripts.toolActivityScript)];
    hooks.PreToolUse = activity;
    hooks.PostToolUse = activity;
    hooks.UserPromptSubmit = activity;
  }
  return { hooks };
}

function readSettings(ctx: CliAdapterLaunchContext): ClaudeCodeLaunchSettings {
  return (ctx.settings ?? {}) as ClaudeCodeLaunchSettings;
}

// ── Launch / resume builders ──────────────────────────────────────────────────

const DEFAULT_COMMAND = "claude";

/**
 * Append the `--settings` flag for the session-scoped hook config. When
 * `settingsPath` is given the JSON is written there (a real session-scoped file)
 * and the flag points at the file; otherwise the JSON is passed inline (`claude
 * --settings <json>` is documented to accept a JSON string). Either way the
 * config is session-scoped and never mutates the user's global config.
 */
function appendSettingsFlag(
  args: string[],
  settings: ClaudeCodeLaunchSettings,
): void {
  if (!settings.hookScripts) return;
  const doc = buildClaudeCodeSettings(settings.hookScripts);
  const json = JSON.stringify(doc);
  if (settings.settingsPath) {
    // Caller guarantees this path is under the session scratch dir.
    writeFileSync(settings.settingsPath, json, "utf8");
    args.push("--settings", settings.settingsPath);
  } else {
    args.push("--settings", json);
  }
}

/** Append the autonomy posture's privileged flags, only when permitted. */
function appendPostureFlags(
  args: string[],
  ctx: CliAdapterLaunchContext,
): void {
  // The visible-posture contract (R21): only emit the dangerous flag when the
  // posture explicitly opts in via `autoApprove`.
  if (ctx.posture?.autoApprove === true) {
    args.push("--dangerously-skip-permissions");
  }
}

function buildBaseArgs(ctx: CliAdapterLaunchContext): { command: string; args: string[] } {
  const settings = readSettings(ctx);
  const command = settings.command ?? DEFAULT_COMMAND;
  const args: string[] = [];
  if (typeof settings.model === "string" && settings.model.length > 0) {
    args.push("--model", settings.model);
  }
  return { command, args };
}

// ── Telemetry mapping ─────────────────────────────────────────────────────────

/** The raw shape of a Claude Code hook payload (all fields optional/tolerant). */
export interface ClaudeHookPayload {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  /** SessionStart source: startup | resume | clear | compact. */
  source?: string;
  /** Notification kind: permission_prompt | idle_prompt | … */
  notification_type?: string;
  /** Some versions surface a tool name on tool hooks. */
  tool_name?: string;
  /** Stop payloads may carry a failure flag in some versions. */
  stop_reason?: string;
  /** A free-form message (Notification / Stop systemMessage etc.). */
  message?: string;
  [key: string]: unknown;
}

/** Notification kinds that mean the agent is blocked waiting on the user. */
const WAITING_NOTIFICATION_TYPES = new Set(["permission_prompt", "idle_prompt"]);

/**
 * Map a raw Claude Code hook payload onto a normalized engine `TelemetryEvent`.
 * Returns `null` for hook events that carry no state-relevant signal (so the
 * caller can drop them). Tolerant of missing optional fields.
 *
 * Mapping (KTD telemetry tiering — native tier):
 *   SessionStart                              → sessionStart (capture session_id
 *                                               + transcript_path)
 *   PreToolUse / PostToolUse / UserPromptSubmit → toolActivity (re-arm watchdog;
 *                                               UserPromptSubmit also implies a
 *                                               fresh busy turn → busy)
 *   PermissionRequest                         → waitingOnInput
 *   Notification{permission_prompt|idle_prompt} → waitingOnInput
 *   Notification{other}                       → toolActivity (informational)
 *   Stop                                      → done (positive completion);
 *                                               see `classifyStop` for failures
 *   SubagentStop / PreCompact / SessionEnd    → outputProgress (activity only)
 */
export function mapHookPayload(payload: ClaudeHookPayload): TelemetryEvent | null {
  const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";
  const nativeSessionId =
    typeof payload.session_id === "string" && payload.session_id.length > 0
      ? payload.session_id
      : undefined;

  const withSession = (
    base: TelemetryEvent,
    extra?: Record<string, unknown>,
  ): TelemetryEvent => {
    const payloadOut: Record<string, unknown> = { ...(base.payload ?? {}), ...(extra ?? {}) };
    if (nativeSessionId) payloadOut.nativeSessionId = nativeSessionId;
    return { kind: base.kind, payload: payloadOut };
  };

  switch (event) {
    case "SessionStart": {
      const extra: Record<string, unknown> = {};
      if (typeof payload.transcript_path === "string") {
        extra.transcriptPath = payload.transcript_path;
      }
      if (typeof payload.source === "string") extra.source = payload.source;
      return withSession({ kind: "sessionStart" }, extra);
    }
    case "UserPromptSubmit":
      // A new user prompt begins a fresh busy turn.
      return withSession({ kind: "busy" });
    case "PreToolUse":
    case "PostToolUse": {
      const extra =
        typeof payload.tool_name === "string" ? { toolName: payload.tool_name } : undefined;
      return withSession({ kind: "toolActivity" }, extra);
    }
    case "PermissionRequest":
      return withSession(
        { kind: "waitingOnInput" },
        { notification: { kind: "permission_request", ...notificationFields(payload) } },
      );
    case "Notification": {
      const kind = typeof payload.notification_type === "string" ? payload.notification_type : "";
      if (WAITING_NOTIFICATION_TYPES.has(kind)) {
        return withSession(
          { kind: "waitingOnInput" },
          { notification: { kind, ...notificationFields(payload) } },
        );
      }
      // Non-blocking notification → informational activity only.
      return withSession({ kind: "toolActivity" });
    }
    case "Stop":
      return classifyStop(payload);
    case "SubagentStop":
    case "PreCompact":
    case "SessionEnd":
      return withSession({ kind: "outputProgress" });
    default:
      // Unknown/unmapped hook event → no state-relevant signal.
      return nativeSessionId ? withSession({ kind: "outputProgress" }) : null;
  }
}

/** Pull the human-facing notification fields onto the normalized notification. */
function notificationFields(payload: ClaudeHookPayload): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof payload.notification_type === "string") out.notificationType = payload.notification_type;
  if (typeof payload.message === "string") out.message = payload.message;
  return out;
}

/**
 * Map a `Stop` payload onto its telemetry event. The happy path is positive
 * completion (`done`). When the payload carries an explicit failure signal
 * (`stop_reason` looks error-ish), map it to a `toolActivity` carrying the
 * failure context instead of `done` — refusing to gate pipeline advancement on
 * a failed stop (the state machine only advances on a genuine `done`).
 */
export function classifyStop(payload: ClaudeHookPayload): TelemetryEvent {
  const nativeSessionId =
    typeof payload.session_id === "string" && payload.session_id.length > 0
      ? payload.session_id
      : undefined;
  const reason = typeof payload.stop_reason === "string" ? payload.stop_reason.toLowerCase() : "";
  const failed = reason.length > 0 && /error|fail|abort|cancel|interrupt/.test(reason);
  const kind: TelemetryEvent["kind"] = failed ? "toolActivity" : "done";
  const out: TelemetryEvent = { kind, payload: {} };
  if (nativeSessionId) out.payload!.nativeSessionId = nativeSessionId;
  if (failed) out.payload!.stopReason = payload.stop_reason;
  return out;
}

/** Whether a SessionStart payload confirms a resume re-attach (`source: "resume"`). */
export function isResumeReattach(payload: ClaudeHookPayload): boolean {
  return payload.hook_event_name === "SessionStart" && payload.source === "resume";
}

/**
 * Parse a raw hook payload string (the JSON delivered on the hook command's
 * stdin) into a normalized event. Returns null on unparseable input — telemetry
 * is best-effort and must never throw at the ingestion boundary.
 */
export function parseHookPayload(raw: string): TelemetryEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  return mapHookPayload(parsed as ClaudeHookPayload);
}

// ── Transcript tailing ─────────────────────────────────────────────────────────

/** A normalized transcript entry surfaced to chat. */
export interface ClaudeTranscriptEntry {
  /** Coarse role for chat rendering. */
  role: "user" | "assistant" | "tool" | "system";
  /** Flattened text content. */
  text: string;
}

/**
 * Incremental JSONL transcript tailer. Claude Code appends one JSON object per
 * line to the file at `transcript_path`; this remembers the byte offset so each
 * `read()` yields only entries appended since the last call. Tolerant of a
 * partial trailing line (held until its newline arrives) and of unparseable
 * lines (skipped).
 */
export class ClaudeTranscriptTailer {
  /** Bytes already consumed from the file. */
  private offset = 0;
  /** A partial trailing line carried across reads until its newline arrives. */
  private partial = "";

  /** Current byte offset (for persistence / tests). */
  get bytesRead(): number {
    return this.offset;
  }

  /**
   * Parse a buffer of newly-appended bytes and return the normalized entries.
   * `chunk` MUST be exactly the bytes appended since the previous call (the
   * caller reads from `bytesRead` to EOF). The tailer advances its offset by the
   * chunk's byte length.
   */
  push(chunk: string): ClaudeTranscriptEntry[] {
    this.offset += Buffer.byteLength(chunk, "utf8");
    const text = this.partial + chunk;
    const lines = text.split("\n");
    // The last element is an incomplete line unless the chunk ended on "\n"
    // (in which case it is "").
    this.partial = lines.pop() ?? "";
    const entries: ClaudeTranscriptEntry[] = [];
    for (const line of lines) {
      const entry = parseTranscriptLine(line);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  /**
   * Flush any buffered complete-but-unterminated final line (e.g. a transcript
   * whose last line lacks a trailing newline). Call on session end.
   */
  flush(): ClaudeTranscriptEntry[] {
    if (this.partial.trim().length === 0) {
      this.partial = "";
      return [];
    }
    const entry = parseTranscriptLine(this.partial);
    this.partial = "";
    return entry ? [entry] : [];
  }
}

/** Parse a single JSONL transcript line into a normalized entry, or null. */
function parseTranscriptLine(line: string): ClaudeTranscriptEntry | null {
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

  const role = normalizeRole(obj);
  const text = extractText(obj);
  if (text.length === 0) return null;
  return { role, text };
}

/**
 * Derive a coarse chat role from a transcript entry. Claude Code transcript rows
 * nest the message under `message.role`/`message.content`; older/flat shapes use
 * a top-level `role`/`type`. We tolerate both.
 */
function normalizeRole(obj: Record<string, unknown>): ClaudeTranscriptEntry["role"] {
  const message = obj.message as Record<string, unknown> | undefined;
  const raw =
    (typeof message?.role === "string" && message.role) ||
    (typeof obj.role === "string" && obj.role) ||
    (typeof obj.type === "string" && obj.type) ||
    "";
  switch (raw) {
    case "user":
    case "human":
      return "user";
    case "assistant":
    case "model":
      return "assistant";
    case "tool":
    case "tool_result":
    case "tool_use":
      return "tool";
    default:
      return "system";
  }
}

/** Flatten the text content of a transcript entry (string or content-block array). */
function extractText(obj: Record<string, unknown>): string {
  const message = obj.message as Record<string, unknown> | undefined;
  const content = message?.content ?? obj.content ?? obj.text;
  return flattenContent(content);
}

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

/**
 * Readiness detector for Claude Code's interactive TUI. Native readiness is
 * hook-driven (the first `SessionStart` hook event marks ready via the telemetry
 * hub), so this output-based detector is the FALLBACK for callers that gate on
 * PTY output before the hook lands. It looks for the input prompt box Claude
 * draws once interactive: a line beginning with the prompt glyph `>` or the
 * bracketed-paste enable sequence the TUI emits when its editor mounts.
 */
export class ClaudeCodeReadinessDetector implements CliReadinessDetector {
  private ready = false;
  private buffer = "";

  observe(chunk: string): boolean {
    if (this.ready) return true;
    // Keep a bounded tail to catch a prompt split across chunks.
    this.buffer = (this.buffer + chunk).slice(-4096);
    // Bracketed-paste enable means the interactive editor mounted.
    if (this.buffer.includes("\x1b[?2004h")) {
      this.ready = true;
      return true;
    }
    // The TUI draws a prompt box; a `>` prompt glyph at a line start is the
    // output-based readiness signal.
    if (/(^|\n)\s*[╭│]?\s*>\s/.test(this.buffer)) {
      this.ready = true;
      return true;
    }
    return false;
  }
}

// ── The adapter ─────────────────────────────────────────────────────────────

export const claudeCodeAdapter: CliAgentAdapter = {
  id: "claude-code",
  name: "Claude Code",
  capabilities: CLAUDE_CODE_CAPABILITIES,
  defaultCommand: DEFAULT_COMMAND,
  elevationMarkers: {
    // Claude Code bypass: `--dangerously-skip-permissions` and the
    // `--permission-mode bypassPermissions` form.
    exactArgs: ["--dangerously-skip-permissions"],
    argPatterns: [/^--permission-mode(=|$)/, /bypassPermissions/i],
    matchArgv(argv) {
      const hits: string[] = [];
      for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--permission-mode" && argv[i + 1] === "bypassPermissions") {
          hits.push("--permission-mode bypassPermissions");
        }
      }
      return hits;
    },
  },

  buildLaunch(ctx: CliAdapterLaunchContext): CliLaunchSpec {
    const settings = readSettings(ctx);
    const { command, args } = buildBaseArgs(ctx);
    appendSettingsFlag(args, settings);
    appendPostureFlags(args, ctx);
    if (settings.extraArgs) args.push(...settings.extraArgs);
    return { command, args };
  },

  buildEnvAllowlist(): string[] {
    // Only what Claude Code needs to authenticate, find its config, and render a
    // terminal. NEVER an inherit-everything posture — FUSION_* service creds and
    // unrelated secrets stay out of the child (the session manager copies ONLY
    // these keys).
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
      "XDG_CONFIG_HOME",
      "XDG_CACHE_HOME",
      "XDG_DATA_HOME",
      "COLORTERM",
      // Claude Code auth (API-key path; OAuth/keychain handled by the binary).
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
    ];
  },

  createReadinessDetector(): CliReadinessDetector {
    return new ClaudeCodeReadinessDetector();
  },

  formatInjection(text: string, _opts: { bracketedPasteActive: boolean }): CliInjectionFormat {
    // The session manager owns bracketed-paste wrapping and the security-critical
    // control-char neutralization. This hook only adds the trailing submit: a
    // carriage return submits the prompt in Claude Code's TUI. We do NOT add a
    // second `\r` when the text already ends in one.
    const payload = text.endsWith("\r") ? text : `${text}\r`;
    return { payload };
  },

  buildResume(ctx: CliAdapterResumeContext): CliLaunchSpec {
    // `claude --resume <session-id>` re-attaches the prior conversation. Resume
    // confirmation arrives as a SessionStart hook with source === "resume" (see
    // `isResumeReattach`). Posture/model flags carry over so a resumed session
    // keeps its launch shape; hook settings are re-applied so telemetry rewires.
    const settings = readSettings(ctx);
    const { command, args } = buildBaseArgs(ctx);
    args.push("--resume", ctx.nativeSessionId);
    appendSettingsFlag(args, settings);
    appendPostureFlags(args, ctx);
    if (settings.extraArgs) args.push(...settings.extraArgs);
    return { command, args };
  },
};
