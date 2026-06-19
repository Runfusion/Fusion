/**
 * ACP transport for the pi-claude-cli provider (U11 — Route A).
 *
 * `streamViaAcp` is the drop-in alternative to `streamViaCli` that drives Claude
 * through the `claude-code-cli-acp` bridge over the Agent Client Protocol instead
 * of `claude -p`. It returns the SAME `AssistantMessageEventStream` shape, so the
 * provider's `streamSimple` can dispatch to either transport behind a kill-switch.
 *
 * Design (see plan U11):
 * - Full-history prompt EVERY turn (`buildPrompt`) — the ACP path has no Claude
 *   `--resume`, so we never send the latest-turn-only `buildResumePrompt` (R13).
 * - MCP tool SCHEMAS are forwarded on `session/new` so Claude knows the Fusion
 *   tools and emits correct `tool_use` calls; we DO NOT let the bridge execute
 *   them. We break early ONLY on a pi-known tool (mirroring the `-p` guard) — and
 *   surface it to pi, which runs the tool itself. Claude's INTERNAL tools
 *   (`ToolSearch`/`Task`/…) are NOT pi-known: we must NOT break on them, or we'd
 *   abort the turn before the real `fn_*` call (Claude uses `ToolSearch` to load
 *   deferred MCP tools first). See review P0 (correctness).
 * - Translation reuses the tested `createEventBridge` by synthesizing Claude
 *   stream events from ACP `session/update`s, so pi event sequencing, tool-name
 *   mapping and arg translation are shared with the `-p` path.
 * - Untrusted-output floor: agent text/thinking is control-char-stripped and
 *   byte-capped; identifiers are bounded (review P1, security).
 *
 * Auth: the bridge spawns the real `claude`, which authenticates from the host
 * login/keychain session (R17). The bridge binary path is injected by the caller
 * (engine seam, KTD10) — this module never reaches into the ACP plugin.
 *
 * NOT-YET-VERIFIED (kill-switch stays OFF until then): the bridge's tool-execution
 * ordering (`session/request_permission` vs `tool_call` update) and native-tool
 * (Read/Write/Bash) execution-prevention need a live behavioral test against the
 * real bridge before any lane enables this path. `requestPermission` denies by
 * default and we break early, but the TOCTOU window is unproven (review P2).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { isAbsolute, join } from "node:path";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { buildPrompt, buildResumePrompt, buildSystemPrompt, type PiContext } from "./prompt-builder.js";
import { createEventBridge } from "./event-bridge.js";
import { registerProcess, captureStderr } from "./process-manager.js";
import { isPiKnownClaudeTool } from "./tool-mapping.js";
import type { ClaudeApiEvent } from "./types.js";

/** A stdio MCP server forwarded on `session/new` (schema-only — never executed here). */
export interface AcpMcpServerSpec {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
}

/** Options for the ACP transport: pi's stream options plus ACP wiring. */
export type StreamViaAcpOptions = SimpleStreamOptions & {
  cwd?: string;
  /** Absolute path to the `claude-code-cli-acp` bridge binary (injected by the engine seam). */
  bridgePath: string;
  /** MCP servers (tool schemas) forwarded so Claude emits correct tool calls. */
  mcpServers?: AcpMcpServerSpec[];
  /** Env keys to forward to the bridge — filtered to the allow-list below regardless. */
  bridgeEnv?: NodeJS.ProcessEnv;
};

const INITIALIZE_TIMEOUT_MS = 30_000;
/** Last-resort guard: kill a silent bridge. Mirrors streamViaCli (30 min). */
const INACTIVITY_TIMEOUT_MS = 30 * 60_000;
/** Untrusted-output bounds (review P1, security). */
const MAX_CHUNK_CHARS = 64 * 1024;
const MAX_TURN_CHARS = 5_000_000;
const MAX_ID_CHARS = 256;

/**
 * FNXC:ClaudeAcp 2026-06-15-11:40:
 * Cross-process signal for the dashboard: when the bridged `claude` can't
 * authenticate (R17 — e.g. a detached daemon with no keychain), the turn comes
 * back as "Not logged in · Please run /login" instead of a real answer. We
 * record that here so `GET /providers/claude-cli/status` can surface it and the
 * UI can prompt the user to fall back to `-p` or fix auth. A real response
 * clears it. Best-effort; the path is recomputed identically dashboard-side.
 */
export const ACP_BRIDGE_AUTH_SIGNAL_PATH = join(tmpdir(), "fusion-acp-bridge-auth.json");
const NOT_LOGGED_IN_RE = /not logged in|please run \/login/i;
let lastAuthFailed: boolean | undefined;

function recordBridgeAuthState(failed: boolean, reason?: string): void {
  if (lastAuthFailed === failed) return; // only write on transition
  lastAuthFailed = failed;
  try {
    if (failed) {
      writeFileSync(
        ACP_BRIDGE_AUTH_SIGNAL_PATH,
        JSON.stringify({ authFailed: true, at: new Date().toISOString(), reason: reason ?? "Claude in the ACP bridge is not logged in" }),
      );
    } else {
      unlinkSync(ACP_BRIDGE_AUTH_SIGNAL_PATH);
    }
  } catch {
    /* best-effort signal — never let it affect the turn */
  }
}

/**
 * Bridge subprocess env allow-list. The bridged `claude` needs HOME (for
 * `~/.claude` auth/keychain, R17) and PATH; terminal vars improve rendering.
 * Inherited `process.env` and any secret-bearing keys are NEVER forwarded — the
 * filter is enforced HERE, not trusted from the caller (review P2, security).
 */
const BRIDGE_ENV_ALLOWLIST = [
  "HOME", "PATH", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE",
  "TERM", "TERMINFO", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "COLORTERM",
];

/**
 * R17 opt-in (detached-daemon auth): a headless daemon can't reach the macOS
 * login Keychain, so `claude` reports "Not logged in". When an operator sets
 * `FUSION_CLAUDE_ACP_FORWARD_AUTH=1` AND provides one of these in the launch
 * environment, we forward it (and ONLY it) so the bridged `claude` can
 * authenticate non-interactively. Default OFF — no secret-bearing var ever
 * reaches the untrusted bridge otherwise. Mirrors the native claude-code
 * adapter's recognized auth vars.
 *
 * Security trade-off (state it where the operator opts in): once forwarded, the
 * token is visible to the bridge subprocess AND everything it spawns (including
 * MCP servers that inherit env). It is NOT in prompt/model context, so the model
 * can't read it, but opting in widens exposure to the bridge process tree.
 * Prefer a scoped/rotatable `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`).
 */
const BRIDGE_AUTH_ENV_KEYS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"];

export function buildBridgeEnv(supplied?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const source = supplied ?? process.env;
  const env: NodeJS.ProcessEnv = {};
  for (const key of BRIDGE_ENV_ALLOWLIST) {
    const v = source[key];
    if (typeof v === "string") env[key] = v;
  }
  // Opt-in only: forward a single Claude auth token from the operator's launch
  // env (always process.env, never the caller-supplied object).
  if (process.env.FUSION_CLAUDE_ACP_FORWARD_AUTH === "1") {
    for (const key of BRIDGE_AUTH_ENV_KEYS) {
      const v = process.env[key];
      // Treat a whitespace-only value as absent, so a blank higher-preference
      // var doesn't shadow a real lower-preference token (and we never forward
      // a useless blank token).
      if (typeof v === "string" && v.trim().length > 0) {
        env[key] = v;
        break; // forward only the highest-preference token that's present
      }
    }
  }
  return env;
}

/** Strip ANSI escape sequences and C0/C1 control chars (keep \n \r \t), then cap length. */
function sanitizeText(text: string, cap = MAX_CHUNK_CHARS): string {
  // eslint-disable-next-line no-control-regex
  const stripped = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  return stripped.length > cap ? stripped.slice(0, cap) : stripped;
}

/** Bound an untrusted identifier (tool id / name) before it becomes a content-block key. */
function boundId(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f/\\]/g, "").slice(0, MAX_ID_CHARS);
}

/**
 * Convert buildPrompt's output into ACP prompt content blocks, PRESERVING image
 * blocks (review P1, correctness — flatten-to-text dropped vision input).
 */
function toAcpPromptBlocks(
  prompt: string | Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  if (typeof prompt === "string") return [{ type: "text", text: prompt }];
  const out: Array<Record<string, unknown>> = [];
  for (const b of prompt) {
    if (b.type === "text" && typeof b.text === "string") {
      out.push({ type: "text", text: b.text });
    } else if (b.type === "image" && b.source && typeof b.source === "object") {
      const src = b.source as { media_type?: string; data?: string };
      if (src.data) out.push({ type: "image", mimeType: src.media_type ?? "image/png", data: src.data });
    }
  }
  return out;
}

/**
 * FNXC:ClaudeAcp 2026-06-15-14:10:
 * Connection-reuse cache (item 1 / OQ2). Gated behind `FUSION_CLAUDE_ACP_REUSE`
 * (default OFF). When on, a live bridge connection + ACP session is kept warm
 * across turns of one conversation (keyed by the stable `options.sessionId`), so
 * multi-turn lanes skip the cold bridge+claude spawn, the `session/new`
 * round-trip, AND the full-history resend — sending only `buildResumePrompt`
 * (delta) on reuse. A stable `router` indirection lets the long-lived connection
 * handler serve each turn's fresh per-call state. Default OFF → the cold path
 * below is functionally unchanged.
 */
const REUSE_IDLE_MS = 5 * 60_000;
interface AcpRouter {
  onUpdate: ((p: { update?: Record<string, unknown> } & Record<string, unknown>) => Promise<void>) | null;
  onPermission: ((p: Record<string, unknown>) => Promise<{ outcome: { outcome: "cancelled" } }>) | null;
  // Liveness: invoked when the warm child dies so the turn CURRENTLY owning the
  // connection fails fast instead of hanging until the inactivity timeout. The
  // long-lived `child.on("close")` is bound to the cold turn's closure, so
  // without this a reuse turn's death would never reach its own `failWith`.
  // Repointed to each turn's `failWith`; nulled on release (idle → just evict).
  fail: ((msg: string) => void) | null;
}
interface CachedAcpConn {
  conn: ClientSideConnection;
  child: ChildProcess;
  acpSessionId: string;
  cwd: string;
  inUse: boolean;
  router: AcpRouter;
  idleTimer?: ReturnType<typeof setTimeout>;
  // Monotonic id of the turn currently owning the connection. A stray
  // session/update from a finished turn is dropped when it no longer matches.
  activeTurn: number;
}
const acpSessionCache = new Map<string, CachedAcpConn>();
let acpTurnCounter = 0;
function acpReuseEnabled(): boolean {
  return process.env.FUSION_CLAUDE_ACP_REUSE === "1";
}
/**
 * Kill a cached connection's child and evict it — but only delete the map key
 * if it STILL points at this exact entry. A concurrent cold turn may have
 * replaced the entry under the same key; a stale close handler / idle timer
 * must not evict (or kill the child of) that newer, live entry. The passed
 * entry's own child is always killed (it is the dead/finished one).
 */
function evictCachedAcpConn(key: string, entry: CachedAcpConn): void {
  if (acpSessionCache.get(key) === entry) acpSessionCache.delete(key);
  if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = undefined; }
  entry.router.onUpdate = null;
  entry.router.onPermission = null;
  entry.router.fail = null;
  try { entry.child.kill("SIGKILL"); } catch { /* registry SIGKILL is authoritative */ }
}

/**
 * Stream a Claude response via the ACP bridge as an `AssistantMessageEventStream`.
 * Mirrors `streamViaCli`'s contract (start → deltas → done; break-early on tools).
 */
export function streamViaAcp(
  model: Model<Api>,
  context: PiContext,
  options: StreamViaAcpOptions,
): AssistantMessageEventStream {
  // @ts-expect-error — pi-ai exports AssistantMessageEventStream as a type; the
  // constructor exists at runtime (same workaround as streamViaCli).
  const stream = new AssistantMessageEventStream();
  const bridge = createEventBridge(stream, model);

  (async () => {
    const cwd = options.cwd ?? process.cwd();
    const reuseKey =
      acpReuseEnabled() && options.sessionId && context.messages.length > 1
        ? options.sessionId
        : undefined;

    let child: ChildProcess | undefined;
    let getStderr: (() => string) | undefined;
    let ended = false;
    let turnChars = 0;
    let blockIndex = -1;
    let openKind: "text" | "thinking" | null = null;
    let sawToolCall = false;
    let inactivity: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    // The cache entry this turn is bound to (set on reuse, or after a cold turn
    // caches its connection). Identity-checked against the map before release.
    let cacheEntry: CachedAcpConn | undefined;
    // This turn's monotonic id, stamped onto the shared cache entry when the
    // turn acquires it. Handlers drop updates once the entry moves to a newer
    // turn (defends the warm connection against cross-turn content bleed).
    let myTurn = 0;

    // End the turn. `destroy` kills+evicts the connection; otherwise a cached
    // connection is released (kept warm for the next turn) and a one-shot
    // (non-reuse) connection is killed.
    const endTurn = (destroy: boolean) => {
      if (inactivity) { clearTimeout(inactivity); inactivity = undefined; }
      if (onAbort && options.signal) options.signal.removeEventListener("abort", onAbort);
      const entry = cacheEntry;
      // A tool-use turn breaks early while `conn.prompt()` is still pending (we
      // never await it on break). Releasing the connection as warm here would
      // let the next turn launch a SECOND concurrent prompt on the same ACP
      // session — protocol corruption. So a tool-use turn always tears down,
      // exactly like the non-reuse path; only a clean `stop` turn (prompt fully
      // resolved before finish) keeps the connection warm.
      const keepWarm =
        !destroy && !sawToolCall && entry !== undefined && reuseKey !== undefined &&
        acpSessionCache.get(reuseKey) === entry;
      if (keepWarm) {
        // Release the warm connection: drop this turn's handlers (so a late
        // update can't reach a finished turn or the liveness hook fire stale),
        // mark idle, and arm an unref'd reaper bound to THIS entry.
        entry!.router.onUpdate = null;
        entry!.router.onPermission = null;
        entry!.router.fail = null;
        entry!.inUse = false;
        if (entry!.idleTimer) clearTimeout(entry!.idleTimer);
        const idle = setTimeout(() => evictCachedAcpConn(reuseKey!, entry!), REUSE_IDLE_MS);
        idle.unref?.(); // a warm-connection idle timer must not keep the process alive
        entry!.idleTimer = idle;
        return;
      }
      if (entry !== undefined && reuseKey !== undefined) {
        // Kills this turn's child; evicts the map key only if still current.
        evictCachedAcpConn(reuseKey, entry);
      } else {
        try { child?.kill("SIGKILL"); } catch { /* registry SIGKILL is authoritative */ }
      }
    };
    const armInactivity = () => {
      if (inactivity) clearTimeout(inactivity);
      inactivity = setTimeout(() => failWith(`ACP bridge inactivity timeout after ${INACTIVITY_TIMEOUT_MS / 1000}s`), INACTIVITY_TIMEOUT_MS);
    };

    const finish = (reason: "stop" | "tool_use") => {
      if (ended) return;
      ended = true;
      if (openKind !== null) bridge.handleEvent({ type: "content_block_stop", index: blockIndex } as ClaudeApiEvent);
      // Downgrade a tool_use turn that surfaced zero pi tool calls → stop, so pi
      // doesn't try to dispatch non-existent tools (mirrors provider.ts:366-375).
      const toolCount = (bridge.getOutput().content ?? []).filter((c) => (c as { type?: string }).type === "toolCall").length;
      // R17: a turn that is ONLY "Not logged in" (no tools, no real text) means
      // the bridged `claude` can't authenticate — signal it for the UI. A real
      // response (tools or non-trivial text) clears the signal.
      const trimmedText = (bridge.getOutput().content ?? [])
        .filter((c) => (c as { type?: string }).type === "text")
        .map((c) => (c as { text?: string }).text ?? "")
        .join("")
        .trim();
      // Only treat it as an auth failure when the WHOLE turn is essentially the
      // bridge's short "Not logged in · Please run /login" message — not when a
      // long, legitimate answer merely mentions the phrase (avoids false positives).
      const isAuthFailure =
        toolCount === 0 && trimmedText.length > 0 && trimmedText.length <= 80 && NOT_LOGGED_IN_RE.test(trimmedText);
      if (isAuthFailure) recordBridgeAuthState(true);
      else if (toolCount > 0 || trimmedText.length > 0) recordBridgeAuthState(false);
      const effective: "stop" | "tool_use" = reason === "tool_use" && toolCount > 0 ? "tool_use" : "stop";
      bridge.handleEvent({ type: "message_delta", delta: { stop_reason: effective === "tool_use" ? "tool_use" : "end_turn" } } as ClaudeApiEvent);
      stream.push({ type: "done", reason: effective === "tool_use" ? "toolUse" : "stop", message: bridge.getOutput() });
      stream.end();
      endTurn(false); // clean turn → keep a cached connection warm for next turn
    };

    const failWith = (msg: string) => {
      if (ended) return;
      ended = true;
      const output = bridge.getOutput();
      stream.push({
        type: "done",
        reason: "stop",
        message: {
          ...output,
          content: output.content?.length ? output.content : [{ type: "text" as const, text: `Error: ${msg}` }],
          stopReason: "stop" as const,
        },
      });
      stream.end();
      endTurn(true); // failed turn → destroy the connection (never reuse a broken one)
    };

    const openBlock = (kind: "text" | "thinking") => {
      if (openKind === kind) return;
      if (openKind !== null) bridge.handleEvent({ type: "content_block_stop", index: blockIndex } as ClaudeApiEvent);
      blockIndex += 1;
      openKind = kind;
      bridge.handleEvent({ type: "content_block_start", index: blockIndex, content_block: { type: kind } } as ClaudeApiEvent);
    };

    // Surface a pi-known tool call to pi and break early (pi executes it, not the bridge).
    const surfaceToolAndBreak = (claudeName: string, rawId: string, rawInput: unknown) => {
      const id = boundId(rawId);
      if (openKind !== null) { bridge.handleEvent({ type: "content_block_stop", index: blockIndex } as ClaudeApiEvent); openKind = null; }
      blockIndex += 1;
      bridge.handleEvent({ type: "content_block_start", index: blockIndex, content_block: { type: "tool_use", name: boundId(claudeName), id } } as ClaudeApiEvent);
      bridge.handleEvent({ type: "content_block_delta", index: blockIndex, delta: { type: "input_json_delta", partial_json: sanitizeText(JSON.stringify(rawInput ?? {})) } } as ClaudeApiEvent);
      bridge.handleEvent({ type: "content_block_stop", index: blockIndex } as ClaudeApiEvent);
      sawToolCall = true;
      finish("tool_use");
    };

    const handleUpdate = async (params: { update?: Record<string, unknown> } & Record<string, unknown>): Promise<void> => {
        if (ended) return;
        // The warm connection is shared across turns; ignore a stray update once
        // the entry has been handed to a newer turn (cross-turn bleed guard).
        if (cacheEntry && cacheEntry.activeTurn !== myTurn) return;
        armInactivity();
        const u = (params.update ?? params) as Record<string, unknown>;
        const kind = u.sessionUpdate as string;
        const content = u.content as { type?: string; text?: string } | undefined;

        if (kind === "agent_message_chunk" && content?.type === "text" && content.text) {
          if (turnChars >= MAX_TURN_CHARS) return;
          openBlock("text");
          const text = sanitizeText(content.text);
          turnChars += text.length;
          bridge.handleEvent({ type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text } } as ClaudeApiEvent);
        } else if (kind === "agent_thought_chunk" && content?.text) {
          if (turnChars >= MAX_TURN_CHARS) return;
          openBlock("thinking");
          const text = sanitizeText(content.text);
          turnChars += text.length;
          bridge.handleEvent({ type: "content_block_delta", index: blockIndex, delta: { type: "thinking_delta", thinking: text } } as ClaudeApiEvent);
        } else if (kind === "tool_call") {
          // Break early ONLY on a pi-known tool. Claude's internal tools
          // (ToolSearch/Task/…) are not pi-known — let the bridge run them so
          // Claude can load deferred MCP schemas and emit the real fn_* call.
          const claudeName = ((u._meta as { claudeCode?: { toolName?: string } } | undefined)?.claudeCode?.toolName) ?? (u.title as string) ?? "";
          if (isPiKnownClaudeTool(claudeName)) {
            surfaceToolAndBreak(claudeName, (u.toolCallId as string) ?? `acp_${blockIndex + 1}`, u.rawInput ?? u.input);
          }
        }
    };

    const handlePermission = async (params: Record<string, unknown>): Promise<{ outcome: { outcome: "cancelled" } }> => {
        // A permission request means the bridge is about to EXECUTE a tool. For a
        // pi-known tool, surface it to pi and break early (pi executes it); deny
        // by default otherwise. We always return cancelled so the bridge never
        // executes Fusion's tools itself.
        if (!ended && !(cacheEntry && cacheEntry.activeTurn !== myTurn)) {
          const tc = (params.toolCall ?? {}) as Record<string, unknown>;
          const claudeName = ((tc._meta as { claudeCode?: { toolName?: string } } | undefined)?.claudeCode?.toolName) ?? (tc.title as string) ?? "";
          if (isPiKnownClaudeTool(claudeName)) {
            surfaceToolAndBreak(claudeName, (tc.toolCallId as string) ?? `acp_${blockIndex + 1}`, tc.rawInput ?? tc.input);
          }
        }
        return { outcome: { outcome: "cancelled" as const } };
    };

    // Usage emission (OQ3) — shared by the cold + reuse paths. Coerces the
    // untrusted bridge usage payload to finite, non-negative numbers.
    const emitUsage = (res: unknown): void => {
      if (sawToolCall) return;
      const u = (res as { usage?: Record<string, unknown> }).usage;
      if (!u) return;
      const num = (x: unknown): number | undefined =>
        typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : undefined;
      bridge.handleEvent({
        type: "message_delta",
        delta: {},
        usage: {
          input_tokens: num(u.inputTokens),
          output_tokens: num(u.outputTokens),
          cache_read_input_tokens: num(u.cachedReadTokens),
          cache_creation_input_tokens: num(u.cachedWriteTokens),
        },
      } as ClaudeApiEvent);
    };

    try {
      const withTimeout = <T>(p: Promise<T>, label: string) =>
        Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`ACP ${label} timeout`)), INITIALIZE_TIMEOUT_MS))]);

      // ── Reuse path: a warm connection for this conversation exists ──────────
      // Skip spawn + initialize + session/new, and send ONLY the latest-turn
      // delta (`buildResumePrompt`) because the warm `claude` session already
      // holds the prior turns server-side (sending full history would duplicate
      // it). Gated by `reuseKey`, which is undefined unless reuse is enabled.
      let warm = reuseKey ? acpSessionCache.get(reuseKey) : undefined;
      // Never reuse a busy connection or one bound to a different cwd.
      if (warm && (warm.inUse || warm.cwd !== cwd)) warm = undefined;
      // A reuse turn sends only the delta; if there's nothing new to send, an
      // empty prompt to the warm session could hang. Drop the warm connection
      // and cold-start with full history instead.
      let resumeBlocks: ReturnType<typeof toAcpPromptBlocks> | undefined;
      if (warm && reuseKey) {
        const resume = buildResumePrompt(context);
        const resumeEmpty = typeof resume === "string" ? resume.trim() === "" : resume.length === 0;
        if (resumeEmpty) { evictCachedAcpConn(reuseKey, warm); warm = undefined; }
        else resumeBlocks = toAcpPromptBlocks(resume as string | Array<Record<string, unknown>>);
      }
      if (warm && reuseKey && resumeBlocks) {
        cacheEntry = warm;
        myTurn = ++acpTurnCounter;
        warm.activeTurn = myTurn;
        warm.inUse = true;
        if (warm.idleTimer) { clearTimeout(warm.idleTimer); warm.idleTimer = undefined; }
        warm.router.onUpdate = handleUpdate;
        warm.router.onPermission = handlePermission;
        warm.router.fail = failWith; // a warm-child death now fails THIS turn fast
        child = warm.child;
        onAbort = () => failWith("aborted");
        if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });
        armInactivity();

        // ACP ContentBlock[] — text/image shapes match; cast through unknown.
        const res = await warm.conn.prompt({ sessionId: warm.acpSessionId, prompt: resumeBlocks as unknown as Parameters<typeof warm.conn.prompt>[0]["prompt"] });
        if (ended) return;
        emitUsage(res);
        if (!sawToolCall) finish("stop");
        return;
      }

      // ── Cold path: spawn the bridge and open a fresh ACP session ───────────
      if (!isAbsolute(options.bridgePath) || !existsSync(options.bridgePath)) {
        failWith(`ACP bridge path invalid (must be an absolute, existing binary): ${options.bridgePath}`);
        return;
      }
      child = spawn(options.bridgePath, [], { stdio: ["pipe", "pipe", "pipe"], cwd, env: buildBridgeEnv(options.bridgeEnv) });
      registerProcess(child);
      getStderr = captureStderr(child);
      // Stable router indirection: the long-lived connection + child handlers
      // always dispatch to whichever turn currently owns the connection. On
      // reuse we repoint `router.*` at the new turn; `router.fail` lets a
      // warm-child death fail the CURRENT owner (not the cold turn it spawned).
      const router: AcpRouter = { onUpdate: handleUpdate, onPermission: handlePermission, fail: failWith };
      child.on("error", (e) => router.fail?.(`ACP bridge spawn failed: ${e.message}`));
      child.on("close", (code) => {
        const msg = `ACP bridge exited (code ${code ?? "?"})${getStderr ? `: ${getStderr().slice(-500)}` : ""}`;
        const fail = router.fail; // capture before evict nulls it
        if (reuseKey && cacheEntry) evictCachedAcpConn(reuseKey, cacheEntry); // a dead child can never be reused
        fail?.(msg); // fail the owning turn (no-op if idle / already ended)
      });
      onAbort = () => failWith("aborted");
      if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });
      armInactivity();

      const acpStream = ndJsonStream(
        Writable.toWeb(child.stdin!) as unknown as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
      );
      const conn = new ClientSideConnection(
        () => ({
          sessionUpdate: (p) => router.onUpdate?.(p as Parameters<NonNullable<AcpRouter["onUpdate"]>>[0]) ?? Promise.resolve(),
          requestPermission: (p) =>
            router.onPermission?.(p as Parameters<NonNullable<AcpRouter["onPermission"]>>[0]) ??
            Promise.resolve({ outcome: { outcome: "cancelled" as const } }),
        }),
        acpStream,
      );

      const init = await withTimeout(
        conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } }),
        "initialize",
      );
      if (ended) return;
      if (init.protocolVersion !== PROTOCOL_VERSION) { failWith(`incompatible ACP protocol ${init.protocolVersion}`); return; }

      const opened = await withTimeout(conn.newSession({ cwd, mcpServers: options.mcpServers ?? [] }), "newSession");
      if (ended) return;

      // Cache the warm connection so the next turn of this conversation reuses
      // it. Only when reuse is enabled (reuseKey set) and the child is live.
      if (reuseKey) {
        myTurn = ++acpTurnCounter;
        cacheEntry = { conn, child, acpSessionId: opened.sessionId, cwd, inUse: true, router, activeTurn: myTurn };
        acpSessionCache.set(reuseKey, cacheEntry);
      }

      const systemPrompt = buildSystemPrompt(context, cwd);
      const blocks = [
        ...(systemPrompt ? [{ type: "text" as const, text: `${systemPrompt}\n\n` }] : []),
        ...toAcpPromptBlocks(buildPrompt(context) as string | Array<Record<string, unknown>>),
      ];

      // ACP ContentBlock[] — text/image shapes match; cast through unknown.
      const res = await conn.prompt({ sessionId: opened.sessionId, prompt: blocks as unknown as Parameters<typeof conn.prompt>[0]["prompt"] });
      if (ended) return;
      // Feed token usage (experimental ACP field) into the bridge BEFORE finish()
      // so it lands in the `done` message. Tool-use turns break early and never
      // resolve here, so they inherently report zero usage. Zero-when-absent safe.
      emitUsage(res);
      if (!sawToolCall) finish("stop");
    } catch (err) {
      failWith(err instanceof Error ? err.message : String(err));
    }
  })();

  return stream;
}
