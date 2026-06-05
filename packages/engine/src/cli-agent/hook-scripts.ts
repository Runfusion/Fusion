/**
 * Per-session hook scripts + notify shim generation (CLI Agent Executor, U17).
 *
 * Fusion launches a CLI agent (Claude Code, Codex, Droid, …) with a
 * session-scoped settings/config dir whose hooks point at small `sh` scripts —
 * the Orca `~/.orca/agent-hooks/*.sh` shape, adapted. Each script reads the hook
 * payload JSON from stdin and POSTs it to the dashboard-served localhost hook
 * endpoint (the engine has NO HTTP server — only the dashboard serves HTTP), with
 * the per-session token carried in a request header.
 *
 * Security / robustness invariants (KTD — hook-endpoint security):
 * - The token is the ONLY authenticator the script holds; the session id alone
 *   is never sufficient server-side (the route validates token-belongs-to-session
 *   against the engine-held registry). The token's at-rest exposure inside the
 *   session-scoped config dir is an accepted, lifetime-bounded risk: the dir is
 *   deleted on session end (`cleanupSessionHookDir`) and the token is
 *   registry-invalidated at the same moment (`hub.invalidate`).
 * - The script NEVER sets an `Origin` header — the route rejects browser-context
 *   requests (Origin/Host CSRF defense). A plain `curl` POST has no Origin.
 * - `curl` uses short connect/total timeouts and the script ALWAYS exits 0, so a
 *   slow / down / wedged endpoint can never block or fail the agent's own hook
 *   chain (telemetry is best-effort; it must not gate the CLI).
 *
 * This module is pure engine code: it only generates script text and writes /
 * removes files. It performs no networking and never mutates the user's global
 * agent config (`~/.claude`, etc.) — only the session-scoped dir it is handed.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Filenames written into the session hook dir. */
export const HOOK_SCRIPT_NAMES = {
  /** Main hook script: POSTs stdin payload (with the hook event name) to the route. */
  hook: "fusion-hook.sh",
  /** Notify shim (Codex `notify` config etc.): POSTs its argv-supplied JSON. */
  notify: "fusion-notify.sh",
} as const;

/** Connect / total curl timeouts (seconds) — must be short; telemetry is best-effort. */
const CURL_CONNECT_TIMEOUT_S = "0.5";
const CURL_MAX_TIME_S = "1.5";

/** HTTP header carrying the per-session hook token (matches the U17 route). */
export const HOOK_TOKEN_HEADER = "X-Fusion-Cli-Session-Token";
/** HTTP header carrying the session id the token must validate for. */
export const HOOK_SESSION_HEADER = "X-Fusion-Cli-Session-Id";

export interface WriteSessionHookScriptsOptions {
  /** Fusion CLI-session id (server validates token-belongs-to-this-session). */
  sessionId: string;
  /** High-entropy per-session hook token minted by the telemetry hub. */
  token: string;
  /**
   * Absolute URL of the dashboard hook ingestion endpoint, e.g.
   * `http://127.0.0.1:4040/api/cli-agent/hooks`. The script POSTs here.
   */
  endpointUrl: string;
  /** Session-scoped config dir to write the scripts into (created if absent). */
  dir: string;
}

export interface WrittenHookScripts {
  /** Absolute path to the main hook script. */
  hookScriptPath: string;
  /** Absolute path to the notify shim script. */
  notifyScriptPath: string;
}

/** Shell-quote a value for safe single-quoted embedding in a generated script. */
function shellSingleQuote(value: string): string {
  // Replace each ' with '\'' (close, escaped quote, reopen).
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the main hook script. It reads the hook payload JSON from stdin and POSTs
 * it to the endpoint with the session token + session id headers. The hook event
 * name (when the agent exposes it via an env var) is forwarded as a query param.
 *
 * Always exits 0; a missing `curl`, an unreachable endpoint, or a non-2xx
 * response must never break the agent's hook execution.
 */
export function buildHookScriptContent(opts: {
  sessionId: string;
  token: string;
  endpointUrl: string;
}): string {
  const endpoint = shellSingleQuote(opts.endpointUrl);
  const token = shellSingleQuote(opts.token);
  const sessionId = shellSingleQuote(opts.sessionId);
  return `#!/bin/sh
# Fusion CLI-agent hook script (generated per session — do not edit).
# Reads the hook payload JSON from stdin and forwards it to the Fusion dashboard
# hook ingestion endpoint. Best-effort: ALWAYS exits 0; never sets an Origin.
set -u
ENDPOINT=${endpoint}
TOKEN=${token}
SESSION_ID=${sessionId}
# Hook event name, when the host CLI exposes it (Claude: CLAUDE_HOOK_EVENT;
# generic fallbacks). Forwarded as a query param so the route can normalize it.
EVENT="\${CLAUDE_HOOK_EVENT:-\${FUSION_HOOK_EVENT:-\${HOOK_EVENT_NAME:-}}}"
PAYLOAD="$(cat)"
if [ -z "$PAYLOAD" ]; then
  PAYLOAD='{}'
fi
URL="$ENDPOINT"
if [ -n "$EVENT" ]; then
  URL="$ENDPOINT?event=$EVENT"
fi
if command -v curl >/dev/null 2>&1; then
  printf '%s' "$PAYLOAD" | curl -sS -X POST "$URL" \\
    --connect-timeout ${CURL_CONNECT_TIMEOUT_S} --max-time ${CURL_MAX_TIME_S} \\
    -H 'Content-Type: application/json' \\
    -H "${HOOK_TOKEN_HEADER}: $TOKEN" \\
    -H "${HOOK_SESSION_HEADER}: $SESSION_ID" \\
    --data-binary @- >/dev/null 2>&1 || true
fi
exit 0
`;
}

/**
 * Build the notify shim. Some CLIs (Codex `notify`) invoke a program with the
 * notification JSON as a single argv argument rather than on stdin. The shim
 * forwards `$1` (falling back to stdin) to the same endpoint with the same auth.
 */
export function buildNotifyShimContent(opts: {
  sessionId: string;
  token: string;
  endpointUrl: string;
}): string {
  const endpoint = shellSingleQuote(opts.endpointUrl);
  const token = shellSingleQuote(opts.token);
  const sessionId = shellSingleQuote(opts.sessionId);
  return `#!/bin/sh
# Fusion CLI-agent notify shim (generated per session — do not edit).
# Forwards the notification JSON (argv[1], else stdin) to the Fusion dashboard
# hook ingestion endpoint. Best-effort: ALWAYS exits 0; never sets an Origin.
set -u
ENDPOINT=${endpoint}
TOKEN=${token}
SESSION_ID=${sessionId}
if [ "$#" -gt 0 ] && [ -n "$1" ]; then
  PAYLOAD="$1"
else
  PAYLOAD="$(cat)"
fi
if [ -z "$PAYLOAD" ]; then
  PAYLOAD='{}'
fi
if command -v curl >/dev/null 2>&1; then
  printf '%s' "$PAYLOAD" | curl -sS -X POST "$ENDPOINT?event=notify" \\
    --connect-timeout ${CURL_CONNECT_TIMEOUT_S} --max-time ${CURL_MAX_TIME_S} \\
    -H 'Content-Type: application/json' \\
    -H "${HOOK_TOKEN_HEADER}: $TOKEN" \\
    -H "${HOOK_SESSION_HEADER}: $SESSION_ID" \\
    --data-binary @- >/dev/null 2>&1 || true
fi
exit 0
`;
}

/**
 * Write the per-session hook script + notify shim into `dir` (created if absent),
 * marked executable (0o700 — owner-only, since they carry the session token).
 * Returns the absolute paths of the written scripts.
 */
export async function writeSessionHookScripts(
  opts: WriteSessionHookScriptsOptions,
): Promise<WrittenHookScripts> {
  const { sessionId, token, endpointUrl, dir } = opts;
  // 0o700: the dir holds the at-rest token — restrict to the owner.
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const hookScriptPath = join(dir, HOOK_SCRIPT_NAMES.hook);
  const notifyScriptPath = join(dir, HOOK_SCRIPT_NAMES.notify);

  await writeFile(hookScriptPath, buildHookScriptContent({ sessionId, token, endpointUrl }), {
    mode: 0o700,
  });
  await writeFile(notifyScriptPath, buildNotifyShimContent({ sessionId, token, endpointUrl }), {
    mode: 0o700,
  });

  return { hookScriptPath, notifyScriptPath };
}

/**
 * Delete the session-scoped hook config dir on session end. The token's at-rest
 * exposure is bounded to the session lifetime; the caller invalidates the token
 * in the hub at the same moment (`hub.invalidate(sessionId)`). Best-effort: a
 * missing dir is not an error.
 */
export async function cleanupSessionHookDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
