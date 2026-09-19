import { randomBytes } from "node:crypto";
import { DAEMON_TOKEN_PREFIX } from "@fusion/core";

/*
FNXC:DesktopHostAuth 2026-08-09-03:04:
The Electron host used to call `createServer(store, {...})` with NO `daemon` token and NO `noAuth`,
then `app.listen(0)` with no host argument. `listen(0)` without a host binds every interface
(0.0.0.0/::), so the entire `/api/*` surface — including the shell-capable terminal WebSocket at
`/api/terminal/ws` — was reachable unauthenticated from the LAN. Both desktop server entrypoints
(local-runtime.ts embedded runtime and the legacy local-server.ts manager) now mount the real bearer
gate with this per-process token and bind loopback only.

Precedent: `runDashboard` in `packages/cli/src/commands/dashboard.ts` deliberately pins the listen
host to 127.0.0.1 for exactly this reason ("Default to localhost so the dashboard (and its
shell-capable terminal API) is not exposed on the LAN"). The desktop host has no `--host` opt-in at
all, so loopback is unconditional here.

The token is generated ONCE per Electron process and never persisted: the desktop server is an
ephemeral loopback listener on an ephemeral port, so there is nothing for a stored token to
authenticate on a later run, and not writing it keeps the desktop host out of the global
`~/.fusion/settings.json` daemon-token lifecycle. Format matches the daemon convention
(`fn_<32 hex>`, see `DaemonTokenManager` in `packages/core/src/cli/daemon-token.ts`) so
`isDaemonTokenFormat` and every existing token-shaped log/redaction path recognizes it.
*/

let cachedToken: string | undefined;

/**
 * The bearer token guarding this Electron process's embedded dashboard API.
 *
 * Stable for the lifetime of the process: the renderer receives it once (through the
 * `localRuntime.authToken` shell state, carried into the runtime-origin navigation as `?token=`)
 * and a restarted embedded server must not invalidate an already-loaded renderer.
 */
export function getDesktopApiToken(): string {
  cachedToken ??= `${DAEMON_TOKEN_PREFIX}${randomBytes(16).toString("hex")}`;
  return cachedToken;
}

/** Loopback host every desktop server entrypoint binds. Never make this configurable. */
export const DESKTOP_SERVER_HOST = "127.0.0.1";
