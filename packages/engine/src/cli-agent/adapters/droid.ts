/**
 * Droid adapter — NATIVE-tier CliAgentAdapter (U5).
 *
 * Droid (Factory's CLI) exposes Claude-style hooks (`Stop`, `Notification`,
 * `SessionStart`, `PreToolUse`/`PostToolUse`) that deliver a JSON payload
 * carrying `session_id`, `transcript_path`, and `permission_mode`. Like Claude
 * Code it is native tier — but with ONE caveat the KTD calls out: its
 * `Notification` hook CONFLATES a permission request and a 60s-idle prompt into a
 * single event whose only discriminator is a free-form `message` text field.
 * This adapter implements a {@link classifyNotification} message classifier that
 * tags the sub-reason while defaulting BOTH to `waitingOnInput` (both mean
 * blocked-on-human).
 *
 * Capability flags advertise the native tier honestly: `nativeDone: true`,
 * `nativeWaiting: true` (via parsing), `transcriptSource: "jsonl"`,
 * `supportsResume: true`.
 *
 * Resume modes (the `-r` footgun):
 *   - INTERACTIVE: `droid --resume <sessionId>` (`-r`/`--resume`).
 *   - HEADLESS:    `droid exec -s <sessionId>` — `-s`/`--session-id`. In `exec`
 *     mode `-r` means `--reasoning-effort`, NOT resume. {@link buildResume}
 *     therefore NEVER emits a bare `-r` for resume in exec mode (asserted in the
 *     tests). VERIFIED against the installed binary's `droid exec --help`.
 *
 * ── Verified against the installed binary (Factory Droid CLI) ──
 *   - `droid` is on PATH (`~/.local/bin/droid`).
 *   - `droid --help`: `-r, --resume [sessionId]`, `--settings <path>` ("Path to
 *     runtime settings file merged for this process only" — the session-scoped
 *     hook-config seam), `--cwd <path>`, `--fork <sessionId>`.
 *   - `droid exec --help`: `-s, --session-id <id>` ("Existing session to
 *     continue (requires a prompt)"), `-r, --reasoning-effort <level>`,
 *     `-o, --output-format <format>`, `--auto <level>`,
 *     `--skip-permissions-unsafe`. CONFIRMS the `-r` footgun.
 *
 * ── Assumed (marked so wiring composes; revisit on drift) ──
 *   - HOOK CONFIG MECHANISM. Droid's `--settings <path>` merges a runtime
 *     settings file for this process only — the session-scoped equivalent of
 *     Claude's `--settings`. We assume it accepts a Claude-style `hooks` block
 *     (event → [{ hooks:[{ type:"command", command }] }]); the binary's hooks
 *     reference is documented as Claude-style. The hook SCRIPTS themselves come
 *     from U17; this adapter only references their paths and emits the settings
 *     JSON. If a Droid version diverges from the Claude hook schema this is the
 *     one place to adjust ({@link buildDroidSettings}).
 *   - The `Notification` payload's idle vs permission discriminator is the
 *     `message` text; {@link classifyNotification} is the documented-gap
 *     classifier.
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
import { stripAnsiControl, type TelemetryEvent } from "../telemetry-hub.js";

// ── Capabilities ────────────────────────────────────────────────────────────

/** Droid native tier: hooks (Stop/Notification/SessionStart) + JSONL + resume. */
export const DROID_CAPABILITIES: CliAdapterCapabilities = {
  nativeDone: true,
  nativeWaiting: true,
  transcriptSource: "jsonl",
  supportsResume: true,
};

// ── Hook script references (U17 seam) ─────────────────────────────────────────

/**
 * Paths to the session-scoped hook scripts the U17 module writes. The adapter
 * does NOT create these — it only references them from the generated settings.
 */
export interface DroidHookScriptRefs {
  /** Script for the `Stop` hook (positive completion). */
  stopScript: string;
  /** Script for the `Notification` hook (permission / idle — see classifier). */
  notificationScript: string;
  /** Script for the `SessionStart` hook (captures session_id / transcript_path). */
  sessionStartScript: string;
  /** Optional script for tool-activity hooks (PreToolUse/PostToolUse). */
  toolActivityScript?: string;
}

/** Adapter-specific launch settings recognized by the Droid adapter. */
export interface DroidLaunchSettings {
  /** Override the `droid` binary. */
  command?: string;
  /** Extra args appended after the computed base args. */
  extraArgs?: readonly string[];
  /** Model override (`--model <id>`). */
  model?: string;
  /** Session-scoped hook script paths (from U17). */
  hookScripts?: DroidHookScriptRefs;
  /**
   * Absolute path to WRITE the session-scoped settings JSON to (merged via
   * `--settings`). MUST live under the session scratch dir — never the user's
   * global Droid config. When absent the adapter passes the JSON inline if the
   * binary accepts it; Droid's `--settings` is documented as a PATH, so a path
   * is strongly preferred (the caller owns containment + lifecycle).
   */
  settingsPath?: string;
}

function readSettings(ctx: CliAdapterLaunchContext): DroidLaunchSettings {
  return (ctx.settings ?? {}) as DroidLaunchSettings;
}

// ── Settings JSON generation (Claude-style hooks, assumed schema) ─────────────

interface HookCommandEntry {
  matcher?: string;
  hooks: { type: "command"; command: string }[];
}

export interface DroidHooksConfig {
  [eventName: string]: HookCommandEntry[];
}

export interface DroidSettings {
  hooks: DroidHooksConfig;
}

/**
 * Build the session-scoped Droid settings document registering our hooks. Schema
 * is assumed Claude-style (see file header): `{ hooks: { EventName: [{ hooks:
 * [{ type:"command", command }] }] } }`. Tool-activity events are registered only
 * when a `toolActivityScript` is supplied.
 */
export function buildDroidSettings(scripts: DroidHookScriptRefs): DroidSettings {
  const cmd = (command: string): HookCommandEntry => ({
    hooks: [{ type: "command", command }],
  });
  const hooks: DroidHooksConfig = {
    SessionStart: [cmd(scripts.sessionStartScript)],
    Stop: [cmd(scripts.stopScript)],
    Notification: [cmd(scripts.notificationScript)],
  };
  if (scripts.toolActivityScript) {
    const activity = [cmd(scripts.toolActivityScript)];
    hooks.PreToolUse = activity;
    hooks.PostToolUse = activity;
  }
  return { hooks };
}

const DEFAULT_COMMAND = "droid";

/** Append the `--settings` flag for the session-scoped hook config. */
function appendSettingsFlag(args: string[], settings: DroidLaunchSettings): void {
  if (!settings.hookScripts) return;
  const doc = buildDroidSettings(settings.hookScripts);
  const json = JSON.stringify(doc);
  if (settings.settingsPath) {
    // Caller guarantees this path is under the session scratch dir.
    writeFileSync(settings.settingsPath, json, "utf8");
    args.push("--settings", settings.settingsPath);
  } else {
    // `--settings` is documented as a path; inline JSON is a best-effort fallback.
    args.push("--settings", json);
  }
}

/** Append the autonomy posture's privileged flags, only when permitted. */
function appendPostureFlags(args: string[], ctx: CliAdapterLaunchContext): void {
  // Visible-posture contract (R21): only bypass approvals when the posture opts
  // in. In interactive mode Droid uses `--auto high` for full autonomy.
  if (ctx.posture?.autoApprove === true) {
    args.push("--auto", "high");
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

// ── Notification classifier (the documented-gap discriminator) ────────────────

/** Sub-reason a Droid `Notification` resolves to after message classification. */
export type DroidNotificationSubReason = "permission_request" | "idle_prompt";

/**
 * Wording that signals a PERMISSION request (vs a passive idle ping). Droid's
 * `Notification` hook fires for both with only a `message` string to tell them
 * apart, so this is a best-effort word classifier (the documented gap).
 */
const PERMISSION_WORDING =
  /\b(permission|approve|approval|allow|grant|confirm|authorize|wants to (?:run|edit|use)|requesting|needs your|asking to|blocked by)\b/i;

/**
 * Classify a Droid `Notification` message into its sub-reason. BOTH outcomes are
 * treated as `waitingOnInput` upstream (both mean blocked-on-human); this only
 * tags WHY for the surface/notification. Default when ambiguous is
 * `permission_request` ONLY when permission wording is present; otherwise
 * `idle_prompt` (the safer default for a generic "waiting" ping).
 */
export function classifyNotification(message: string | undefined): DroidNotificationSubReason {
  const text = typeof message === "string" ? message : "";
  // Permission wording wins whenever present (even alongside idle wording): a
  // permission request is the more actionable, blocking sub-reason. A bare ping
  // with no permission wording defaults to idle.
  if (PERMISSION_WORDING.test(text)) return "permission_request";
  return "idle_prompt";
}

// ── Hook payload → telemetry ──────────────────────────────────────────────────

/** The raw shape of a Droid hook payload (tolerant of missing fields). */
export interface DroidHookPayload {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  permission_mode?: string;
  source?: string;
  tool_name?: string;
  message?: string;
  stop_reason?: string;
  [key: string]: unknown;
}

/**
 * Map a raw Droid hook payload onto a normalized engine `TelemetryEvent`.
 * Returns null for events with no state-relevant signal. Tolerant of missing
 * optional fields.
 *
 * Mapping (KTD telemetry tiering — native tier):
 *   SessionStart                 → sessionStart (capture session_id +
 *                                  transcript_path + permission_mode)
 *   PreToolUse / PostToolUse     → toolActivity (re-arm watchdog)
 *   Notification                 → waitingOnInput (sub-reason via classifier)
 *   Stop                         → done (positive completion); see classifyStop
 */
export function mapHookPayload(payload: DroidHookPayload): TelemetryEvent | null {
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
      if (typeof payload.permission_mode === "string") {
        extra.permissionMode = payload.permission_mode;
      }
      if (typeof payload.source === "string") extra.source = payload.source;
      return withSession({ kind: "sessionStart" }, extra);
    }
    case "PreToolUse":
    case "PostToolUse": {
      const extra =
        typeof payload.tool_name === "string" ? { toolName: payload.tool_name } : undefined;
      return withSession({ kind: "toolActivity" }, extra);
    }
    case "Notification": {
      // The conflated event: classify the message to tag the sub-reason. Both
      // outcomes mean blocked-on-human → waitingOnInput.
      const subReason = classifyNotification(payload.message);
      return withSession(
        { kind: "waitingOnInput" },
        {
          notification: {
            kind: subReason,
            ...(typeof payload.message === "string" ? { message: payload.message } : {}),
          },
        },
      );
    }
    case "Stop":
      return classifyStop(payload);
    default:
      return nativeSessionId ? withSession({ kind: "outputProgress" }) : null;
  }
}

/**
 * Map a `Stop` payload onto its telemetry event. Happy path is `done`; an
 * explicit error-ish `stop_reason` downgrades to `toolActivity` (refusing to
 * gate pipeline advancement on a failed stop), mirroring the Claude adapter.
 */
export function classifyStop(payload: DroidHookPayload): TelemetryEvent {
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

/**
 * Parse a raw hook payload string (delivered on the hook command's stdin) into a
 * normalized event. Returns null on unparseable input — never throws.
 */
export function parseHookPayload(raw: string): TelemetryEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  return mapHookPayload(parsed as DroidHookPayload);
}

// ── Transcript tailing (JSONL, Claude-style nesting) ──────────────────────────

export interface DroidTranscriptEntry {
  role: "user" | "assistant" | "tool" | "system";
  text: string;
}

/**
 * Incremental JSONL transcript tailer. Droid appends one JSON object per line to
 * the file at `transcript_path`. Mirrors the Claude tailer's offset tracking,
 * partial-line handling, and unparseable-line tolerance.
 */
export class DroidTranscriptTailer {
  private offset = 0;
  private partial = "";

  get bytesRead(): number {
    return this.offset;
  }

  push(chunk: string): DroidTranscriptEntry[] {
    this.offset += Buffer.byteLength(chunk, "utf8");
    const text = this.partial + chunk;
    const lines = text.split("\n");
    this.partial = lines.pop() ?? "";
    const entries: DroidTranscriptEntry[] = [];
    for (const line of lines) {
      const entry = parseTranscriptLine(line);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  flush(): DroidTranscriptEntry[] {
    if (this.partial.trim().length === 0) {
      this.partial = "";
      return [];
    }
    const entry = parseTranscriptLine(this.partial);
    this.partial = "";
    return entry ? [entry] : [];
  }
}

function parseTranscriptLine(line: string): DroidTranscriptEntry | null {
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

function normalizeRole(obj: Record<string, unknown>): DroidTranscriptEntry["role"] {
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
 * Readiness detector for Droid's interactive TUI. Native readiness arrives as
 * the first `SessionStart` hook (telemetry-driven); this output-based detector is
 * the FALLBACK for callers gating on PTY output. Ready on the bracketed-paste
 * enable sequence or a prompt glyph at a line's trailing edge.
 */
export class DroidReadinessDetector implements CliReadinessDetector {
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
    if (/(^|\n)\s*[╭│]?\s*[>❯]\s/.test(stripped)) {
      this.ready = true;
      return true;
    }
    return false;
  }
}

// ── The adapter ─────────────────────────────────────────────────────────────

export const droidAdapter: CliAgentAdapter = {
  id: "droid",
  name: "Droid",
  capabilities: DROID_CAPABILITIES,
  defaultCommand: DEFAULT_COMMAND,
  elevationMarkers: {
    // Droid elevation: `--skip-permissions-unsafe` and `--auto <high|...>` full
    // autonomy levels (per `droid --help`). `--auto low` is NOT treated as
    // elevation; only `high`/`medium` levels bypass meaningful approvals.
    exactArgs: ["--skip-permissions-unsafe"],
    argPatterns: [/^--auto=(high|medium)$/i],
    matchArgv(argv) {
      const hits: string[] = [];
      for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--auto" && /^(high|medium)$/i.test(argv[i + 1] ?? "")) {
          hits.push(`--auto ${argv[i + 1]}`);
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
    // Only what Droid needs to authenticate, find its config, and render a
    // terminal. NEVER inherit-everything — FUSION_* creds stay out of the child.
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
      // Factory Droid auth.
      "FACTORY_API_KEY",
    ];
  },

  createReadinessDetector(): CliReadinessDetector {
    return new DroidReadinessDetector();
  },

  formatInjection(text: string, _opts: { bracketedPasteActive: boolean }): CliInjectionFormat {
    // Session manager owns paste-wrapping + neutralization; we add the submit CR.
    const payload = text.endsWith("\r") ? text : `${text}\r`;
    return { payload };
  },

  buildResume(ctx: CliAdapterResumeContext): CliLaunchSpec {
    // Resume mode is selected via the settings: headless `exec -s <id>` vs
    // interactive `--resume <id>`. The exec path NEVER uses `-r` (that is
    // `--reasoning-effort` in exec mode). The presence of a headless/exec request
    // is signalled by `extraArgs` containing `exec`, or by an explicit
    // `execMode` flag on settings; default is interactive.
    const settings = readSettings(ctx) as DroidLaunchSettings & { execMode?: boolean };
    const command = settings.command ?? DEFAULT_COMMAND;

    if (settings.execMode === true) {
      // Headless: `droid exec -s <sessionId>` — NEVER `-r`.
      const args: string[] = ["exec", "-s", ctx.nativeSessionId];
      if (typeof settings.model === "string" && settings.model.length > 0) {
        args.push("--model", settings.model);
      }
      if (ctx.posture?.autoApprove === true) args.push("--auto", "high");
      if (settings.extraArgs) args.push(...settings.extraArgs);
      return { command, args };
    }

    // Interactive: `droid --resume <sessionId>`.
    const { args } = buildBaseArgs(ctx);
    args.push("--resume", ctx.nativeSessionId);
    appendSettingsFlag(args, settings);
    appendPostureFlags(args, ctx);
    if (settings.extraArgs) args.push(...settings.extraArgs);
    return { command, args };
  },
};
