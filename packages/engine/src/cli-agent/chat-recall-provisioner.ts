/**
 * Per-spawn chat recall provisioner (RUFU-128, Step 3).
 *
 * RUFU-120 delivered per-turn memory recall to the in-process chat and
 * executor lanes. This module closes the CLI-agent PTY chat path: a
 * `purpose="chat"` session gets, per spawn (and re-provisioned on resume), a
 * per-session scratch dir holding ONE artifact set generated from the
 * session's adapter:
 *
 * - claude-code → `recall-hook.sh` (a Claude Code `UserPromptSubmit` hook
 *   script) + `recall-settings.json` (a session-scoped settings file with a
 *   single UserPromptSubmit entry pointing at the script, delivered by the
 *   adapter via `--settings`).
 * - pi → `recall-extension.ts` (a pi `before_agent_start` extension,
 *   jiti-loaded, delivered by the adapter via `--extension`).
 *
 * Both artifacts POST the operator prompt to the loopback
 * `POST /api/cli-agent/memory-recall` route (per-session TelemetryHub token
 * auth, mirroring `/api/cli-agent/hooks`) and inject the returned cue through
 * the CLI's NATIVE channel only — the hook's stdout / a display-false custom
 * message. The recall cue is NEVER injected into the PTY/composer by the
 * engine.
 *
 * FNXC:CliChatRecall 2026-08-19-19:30:
 * RUFU-128 terminate→resume lifecycle contract (the Plan Review round-1
 * blocker, resolved here):
 *
 * - Provisioning is CHAT-ONLY and settings-gated. `launchSettingsFor` reads
 *   the session record FIRST: a non-chat (task) purpose returns `null` (bare
 *   spawn — task sessions byte-unchanged) BEFORE any token is issued or
 *   artifact written. A fresh settings read finding `memoryEnabled === false`
 *   or `memoryPerTurnRecallEnabled === false` also returns `null`; a live
 *   toggle therefore takes effect on the next spawn. Only the two
 *   native-channel adapters (claude-code, pi) get artifacts; any other
 *   adapter launches bare (graceful degrade — no fabricated hook wiring).
 *
 * - Resolution is IDEMPOTENT and SELF-HEALING: the scratch dir resolves as
 *   Map hit AND the dir still exists on disk → reuse; otherwise a fresh
 *   `mkdtemp` under the root with the `fusion-cli-recall-` prefix + Map set.
 *   The existence check means a stale Map entry (dir already deleted by a
 *   racing teardown) self-heals to a fresh mkdtemp instead of an ENOENT.
 *
 * - TERMINATION is ordered: (1) the Map entry is deleted SYNCHRONOUSLY first
 *   (a concurrent `launchSettingsFor` — resume racing teardown — therefore
 *   always mkdtemps fresh), (2) the dir is best-effort recursively
 *   force-removed (fire-and-forget: the manager's termination callback is
 *   synchronous and swallows errors, so the rm must not block or throw),
 *   (3) the session's hub token is best-effort invalidated — closing the
 *   in-process hole where a killed chat session's hook token would otherwise
 *   stay valid until engine restart. A terminate→resume therefore re-mints a
 *   FRESH token (the old one is dead) and re-provisions fresh artifacts in a
 *   fresh dir — resume always re-provisions, never reuses.
 *
 * - TERMINATE MUST NOT TOUCH TASK SESSIONS. The manager's termination
 *   callback fires for EVERY session (task and chat). A session this
 *   provisioner never provisioned (no Map entry — task purpose, disabled
 *   recall, unsupported adapter) is a FULL no-op: no rm, no hub invalidation.
 *   Task-session teardown calls `hub.flush(sessionId)` + `hub.invalidate`
 *   AFTER the manager's callback, so invalidating a task session's hub entry
 *   here would silently drop its final redacted carry tail.
 *
 * - `finalize` is DEFENSIVE: it mkdirs the dir recursively (0o700) before
 *   writing artifacts, so any residual ordering race re-creates the dir
 *   rather than throwing ENOENT. All created dirs/files are 0o700 (they carry
 *   the session token at rest — the hook-scripts convention; explicit chmod
 *   because write modes are umask-masked).
 *
 * - BOOT-TIME ORPHAN SWEEP: at construction, a bounded single-level
 *   `readdirSync` of the project-scoped scratch root (NEVER an OS temp-root
 *   walk) force-removes any `fusion-cli-recall-*` child — a dir present at
 *   engine boot belongs to a dead engine process (tokens are not persisted;
 *   the PTY is dead; no resume can reuse a stale token).
 */

import { chmodSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CliSession, Settings } from "@fusion/core";
import { buildClaudeCodeSettings } from "./adapters/claude-code.js";
import type { TelemetryHub } from "./telemetry-hub.js";

/** Prefix of the per-spawn scratch dirs (the boot sweep's match set). */
export const CHAT_RECALL_SCRATCH_PREFIX = "fusion-cli-recall-";

/** Filenames of the generated per-session artifacts. */
export const CHAT_RECALL_ARTIFACT_NAMES = {
  /** Claude Code `UserPromptSubmit` recall hook script. */
  claudeHookScript: "recall-hook.sh",
  /** Claude Code session-scoped settings file (single UserPromptSubmit entry). */
  claudeSettings: "recall-settings.json",
  /** pi `before_agent_start` recall extension (TypeScript, jiti-loaded). */
  piExtension: "recall-extension.ts",
} as const;

const CLAUDE_CODE_ADAPTER_ID = "claude-code";
const PI_ADAPTER_ID = "pi";

/**
 * The runtime constructs the provisioner BEFORE the TelemetryHub (the manager
 * is built before the hub), so the hub arrives through a small mutable holder
 * that the runtime populates immediately after hub construction. `null` at
 * launch/finalize time is an internal error (spawn fails loudly — the runtime
 * always populates before any spawn can run); `terminate` treats it as
 * best-effort (see the module header — the manager swallows teardown throws).
 */
export interface ChatRecallHubHolder {
  hub: TelemetryHub | null;
}

export interface ChatRecallProvisionerOptions {
  /** The project's `.fusion` dir — the default scratch root is `<rootDir>/tmp`. */
  rootDir: string;
  /** Absolute loopback URL of the dashboard memory-recall route. */
  recallEndpointUrl: string;
  /** Hub holder (populated by the runtime after hub construction). */
  hub: ChatRecallHubHolder;
  /** Read a session record by id (the manager's store). */
  getSession: (sessionId: string) => CliSession | undefined;
  /**
   * Fresh settings read at spawn time (the RUFU-128 settings gate). Absent →
   * default-on (the schema defaults are both `true`).
   */
  getSettings?: () => Promise<Partial<Settings> | null | undefined>;
  /** Test override for the scratch root (default `<rootDir>/tmp`). */
  scratchRoot?: string;
}

/**
 * Shell-quote a value for safe single-quoted embedding in a generated script.
 * (Same convention as `hook-scripts.ts` `shellSingleQuote` — copied, not
 * imported: hook-scripts.ts is out of this task's file scope, and the
 * convention — not the code — is what must stay consistent.)
 */
function shellSingleQuote(value: string): string {
  // Replace each ' with '\'' (close, escaped quote, reopen).
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Write a file 0o700 regardless of the process umask (token-carrying). */
function writePrivateFile(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
  // writeFileSync's mode is umask-masked; the artifacts carry the session
  // token at rest and must be owner-only.
  chmodSync(path, 0o700);
}

/** True iff `path` exists and is a directory (false on any fs error). */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export class ChatRecallProvisioner {
  private readonly recallEndpointUrl: string;
  private readonly scratchRoot: string;
  private readonly hub: ChatRecallHubHolder;
  private readonly getSession: (sessionId: string) => CliSession | undefined;
  private readonly getSettings?: () => Promise<Partial<Settings> | null | undefined>;
  /** Live scratch dirs per session id (per-spawn mkdtemp; deleted on terminate). */
  private readonly dirs = new Map<string, string>();

  constructor(options: ChatRecallProvisionerOptions) {
    this.recallEndpointUrl = options.recallEndpointUrl;
    this.hub = options.hub;
    this.getSession = options.getSession;
    this.getSettings = options.getSettings;
    this.scratchRoot = options.scratchRoot ?? join(options.rootDir, "tmp");
    // 0o700: the scratch tree holds at-rest session tokens.
    mkdirSync(this.scratchRoot, { recursive: true, mode: 0o700 });
    this.sweepOrphanedDirs();
  }

  /**
   * Launch-settings contribution for a spawn (the manager's
   * `launchSettingsProvider` body). Returns `null` for every session that must
   * launch bare (non-chat, recall disabled, unsupported adapter) — BEFORE any
   * token issuance or artifact write — or the adapter-facing launch settings:
   *
   * - claude-code: `{ hookScripts: { memoryRecallScript }, settingsPath }`
   * - pi: `{ extensionPath }`
   *
   * Throws when the record is missing (internal error — the manager contract
   * guarantees the record exists at provider time) or when the hub holder is
   * not populated (fail the spawn loudly rather than ship an unauthenticated
   * artifact).
   */
  async launchSettingsFor(sessionId: string): Promise<Record<string, unknown> | null> {
    const record = this.getSession(sessionId);
    if (!record) {
      throw new Error(`chat-recall provisioner: no session record for "${sessionId}"`);
    }
    // Chat-only: task purposes (execute/planning/validator/ce) are never
    // provisioned — the return happens before token issuance and artifacts.
    if (record.purpose !== "chat") return null;
    // Spawn-time settings gate: read FRESH so a live memory toggle takes
    // effect on the next spawn. Absent fields mean "default on"; a settings
    // read FAILURE also defaults on (the per-turn recall service re-checks
    // the settings itself and silently skips — provisioning is cheap and the
    // turn-level gate is the authoritative one).
    if (this.getSettings) {
      let settings: Partial<Settings> | null | undefined;
      try {
        settings = await this.getSettings();
      } catch {
        settings = undefined;
      }
      if (settings?.memoryEnabled === false || settings?.memoryPerTurnRecallEnabled === false) {
        return null;
      }
    }
    // Only the two native-channel adapters get recall artifacts.
    if (record.adapterId !== CLAUDE_CODE_ADAPTER_ID && record.adapterId !== PI_ADAPTER_ID) {
      return null;
    }
    const dir = await this.resolveScratchDir(sessionId);
    // The token is issued via the hub (idempotent: a re-issue after
    // terminate→invalidate mints fresh). `finalize` re-issues and embeds the
    // same token.
    this.requireHub("launchSettingsFor").issueToken(sessionId);
    if (record.adapterId === CLAUDE_CODE_ADAPTER_ID) {
      return {
        hookScripts: { memoryRecallScript: join(dir, CHAT_RECALL_ARTIFACT_NAMES.claudeHookScript) },
        settingsPath: join(dir, CHAT_RECALL_ARTIFACT_NAMES.claudeSettings),
      };
    }
    return { extensionPath: join(dir, CHAT_RECALL_ARTIFACT_NAMES.piExtension) };
  }

  /**
   * Write the session's recall artifacts (called by the runtime's provider
   * lambda after `launchSettingsFor` returned non-null, before the manager
   * merges the settings into the launch context). Throws on any internal
   * inconsistency (missing record/dir/hub) — a spawn with a broken recall
   * artifact is worse than a loud failure.
   */
  async finalize(sessionId: string): Promise<void> {
    const record = this.getSession(sessionId);
    if (!record || record.purpose !== "chat") {
      throw new Error(
        `chat-recall provisioner: finalize for unknown or non-chat session "${sessionId}"`,
      );
    }
    const dir = this.dirs.get(sessionId);
    if (!dir) {
      // Ordering invariant: launchSettingsFor must have run first (the
      // runtime lambda enforces this). No dir → internal error, fail loudly.
      throw new Error(
        `chat-recall provisioner: no scratch dir for "${sessionId}" (finalize before launchSettingsFor?)`,
      );
    }
    const token = this.requireHub("finalize").issueToken(sessionId);
    // Defensive re-creation: an external rm between launchSettingsFor and
    // finalize (or a torn-down dir) heals here instead of throwing ENOENT.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (record.adapterId === CLAUDE_CODE_ADAPTER_ID) {
      const scriptPath = join(dir, CHAT_RECALL_ARTIFACT_NAMES.claudeHookScript);
      writePrivateFile(
        scriptPath,
        buildClaudeRecallHookScript({ sessionId, token, endpointUrl: this.recallEndpointUrl }),
      );
      // Reuse the adapter's settings builder — the single writer of the
      // generated settings shape (a recall-only ref set emits exactly one
      // UserPromptSubmit entry and nothing else).
      const settingsPath = join(dir, CHAT_RECALL_ARTIFACT_NAMES.claudeSettings);
      writePrivateFile(settingsPath, JSON.stringify(buildClaudeCodeSettings({ memoryRecallScript: scriptPath })));
    } else if (record.adapterId === PI_ADAPTER_ID) {
      const extensionPath = join(dir, CHAT_RECALL_ARTIFACT_NAMES.piExtension);
      writePrivateFile(
        extensionPath,
        buildPiRecallExtension({ sessionId, token, endpointUrl: this.recallEndpointUrl }),
      );
    } else {
      throw new Error(`chat-recall provisioner: unsupported adapter "${record.adapterId}"`);
    }
  }

  /**
   * Termination callback (the manager's `onSessionTerminated` body). Ordered:
   * (1) synchronous Map-entry deletion, (2) best-effort recursive force-rm
   * (fire-and-forget), (3) best-effort hub invalidation. A session this
   * provisioner never provisioned (no Map entry) is a full no-op — see the
   * module header for why that must not touch task-session hub state.
   */
  terminate(sessionId: string): void {
    const dir = this.dirs.get(sessionId);
    if (!dir) return; // un-provisioned (task session / disabled / unsupported)
    this.dirs.delete(sessionId);
    void rm(dir, { recursive: true, force: true }).catch(() => {
      // Best-effort: a lost rm is reclaimed by the next boot's orphan sweep.
    });
    const hub = this.hub.hub;
    if (!hub) return; // impossible after a real spawn; teardown must not throw
    try {
      hub.invalidate(sessionId);
    } catch {
      // Best-effort (the manager swallows teardown errors anyway).
    }
  }

  /** Idempotent + existence-checked scratch-dir resolution (see header). */
  private async resolveScratchDir(sessionId: string): Promise<string> {
    const existing = this.dirs.get(sessionId);
    if (existing && isDirectory(existing)) return existing;
    // Stale Map entry (dir already gone) or first resolution: a fresh
    // per-spawn mkdtemp — never reuse a deleted name.
    if (existing) this.dirs.delete(sessionId);
    const dir = await mkdtemp(join(this.scratchRoot, CHAT_RECALL_SCRATCH_PREFIX));
    // Explicit chmod: mkdtemp's mode is umask-masked; the tree must be 0o700.
    chmodSync(dir, 0o700);
    this.dirs.set(sessionId, dir);
    return dir;
  }

  private requireHub(why: string): TelemetryHub {
    const hub = this.hub.hub;
    if (!hub) {
      throw new Error(
        `chat-recall provisioner: hub not available (${why}) — the runtime must populate the hub holder before spawn`,
      );
    }
    return hub;
  }

  /**
   * Boot-time orphan sweep: a bounded single-level scan of the (project-
   * scoped) scratch root; every `fusion-cli-recall-*` dir is force-removed.
   * Best-effort: a missing/unreadable root is skipped, never fatal.
   */
  private sweepOrphanedDirs(): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(this.scratchRoot, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.name.startsWith(CHAT_RECALL_SCRATCH_PREFIX) || !entry.isDirectory()) continue;
      try {
        rmSync(join(this.scratchRoot, entry.name), { recursive: true, force: true });
      } catch {
        // Best-effort sweep; the next boot retries.
      }
    }
  }
}

/**
 * Build the Claude Code `UserPromptSubmit` recall hook script. Claude Code
 * invokes the hook command once per user prompt, delivering the hook payload
 * JSON (with `prompt`) on stdin; the hook's stdout is injected into the
 * conversation. The script extracts `prompt`, POSTs `{"prompt": "…"}` to the
 * recall route with the per-session token + session headers, and prints the
 * cue (or nothing) to stdout.
 *
 * Best-effort invariants (hook-scripts convention, RUFU-128 recall variant):
 * ALWAYS exits 0; never sets an `Origin` header; short curl timeouts so a
 * down endpoint can never block the turn; `-f` so a non-2xx (e.g. a token
 * invalidated mid-session) prints NOTHING — the conversation must never
 * receive an error body as "context". Prompt extraction is node-first (the
 * claude CLI itself is a node program, so node is present whenever this hook
 * can run) with a jq fallback; if neither is available the hook silently
 * no-ops (no cue, no error).
 */
export function buildClaudeRecallHookScript(opts: {
  sessionId: string;
  token: string;
  endpointUrl: string;
}): string {
  const endpoint = shellSingleQuote(opts.endpointUrl);
  const token = shellSingleQuote(opts.token);
  const sessionId = shellSingleQuote(opts.sessionId);
  return `#!/bin/sh
# Fusion CLI chat memory-recall hook (RUFU-128 — generated per session, do not edit).
# Claude Code UserPromptSubmit hook: reads the hook payload JSON on stdin,
# extracts the user prompt, POSTs {"prompt": "<prompt>"} to the Fusion
# dashboard memory-recall endpoint, and prints the returned recall cue (or
# nothing) to stdout — Claude Code injects the hook's stdout into the
# conversation. The cue travels only through this native channel; the engine
# never touches the PTY/composer.
# Best-effort: ALWAYS exits 0; never sets an Origin header; short timeouts so
# a down endpoint can never block the turn.
set -u
ENDPOINT=${endpoint}
TOKEN=${token}
SESSION_ID=${sessionId}
PAYLOAD="$(cat)"
if [ -z "$PAYLOAD" ]; then
  exit 0
fi
# Extract the prompt from the hook payload (node first, jq fallback; neither
# present → silent no-op). The prompt travels on stdin, never on argv.
BODY=""
if command -v node >/dev/null 2>&1; then
  BODY="$(printf '%s' "$PAYLOAD" | node -e 'let d="";process.stdin.on("data",c=>{d+=c}).on("end",()=>{try{const p=JSON.parse(d).prompt;process.stdout.write(JSON.stringify({prompt:typeof p==="string"?p:""}))}catch(e){}})' 2>/dev/null)" || BODY=""
elif command -v jq >/dev/null 2>&1; then
  BODY="$(printf '%s' "$PAYLOAD" | jq -c '{prompt: (.prompt // "")}' 2>/dev/null)" || BODY=""
fi
if [ -z "$BODY" ] || [ "$BODY" = '{"prompt":""}' ]; then
  exit 0
fi
# -f: a non-2xx response prints nothing (the turn must never receive an error
# body as "context"); || true: a missing curl or connection failure degrades
# to a silent no-op.
if command -v curl >/dev/null 2>&1; then
  printf '%s' "$BODY" | curl -sS -f -X POST "$ENDPOINT" \\
    --connect-timeout 0.5 --max-time 2.0 \\
    -H 'Content-Type: application/json' \\
    -H "X-Fusion-Cli-Session-Token: $TOKEN" \\
    -H "X-Fusion-Cli-Session-Id: $SESSION_ID" \\
    --data-binary @- 2>/dev/null || true
fi
exit 0
`;
}

/**
 * Build the pi `before_agent_start` recall extension (TypeScript, jiti-
 * loaded; the pi extension loader requires a FUNCTION default export). On
 * each user prompt the handler POSTs the prompt to the recall route and — on
 * a successful non-empty cue — returns it as a HIDDEN custom message
 * (`display: false` → invisible in the TUI, present in the LLM context). Any
 * failure (network, auth, empty cue) resolves to "no cue": the handler never
 * throws into the agent loop and the turn proceeds undisturbed. node fetch
 * sends no `Origin` header (the route rejects browser requests).
 */
export function buildPiRecallExtension(opts: {
  sessionId: string;
  token: string;
  endpointUrl: string;
}): string {
  const endpoint = JSON.stringify(opts.endpointUrl);
  const token = JSON.stringify(opts.token);
  const sessionId = JSON.stringify(opts.sessionId);
  return `/**
 * Fusion CLI chat memory-recall extension (RUFU-128 — generated per session,
 * do not edit).
 *
 * pi "before_agent_start" hook: POSTs the user prompt to the Fusion
 * dashboard memory-recall endpoint and — when a cue comes back — returns it
 * as a HIDDEN custom message (display: false → invisible in the TUI, present
 * in the LLM context). The cue travels only through this native channel; the
 * engine never touches the PTY/composer.
 *
 * Best-effort: the handler never throws into the agent loop — any network or
 * auth failure resolves to "no cue" and the turn proceeds undisturbed. node
 * fetch sends no Origin header (the route rejects browser requests).
 */
const ENDPOINT = ${endpoint};
const TOKEN = ${token};
const SESSION_ID = ${sessionId};

interface RecallEvent {
  prompt?: unknown;
}
interface RecallResult {
  message?: { customType: string; content: string; display: boolean };
}
interface RecallResponse {
  ok: boolean;
  text(): Promise<string>;
}
interface RecallApi {
  on(
    event: string,
    handler: (event: RecallEvent) => RecallResult | void | Promise<RecallResult | void>,
  ): void;
}

export default function (pi: RecallApi): void {
  pi.on("before_agent_start", async (event: RecallEvent) => {
    const prompt = typeof event.prompt === "string" ? event.prompt : "";
    if (prompt.trim().length === 0) return;
    let response: RecallResponse;
    try {
      response = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-fusion-cli-session-token": TOKEN,
          "x-fusion-cli-session-id": SESSION_ID,
        },
        body: JSON.stringify({ prompt }),
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      return;
    }
    if (!response.ok) return;
    let cue = "";
    try {
      cue = (await response.text()).trim();
    } catch {
      return;
    }
    if (cue.length === 0) return;
    return { message: { customType: "fusion-memory-recall", content: cue, display: false } };
  });
}
`;
}
