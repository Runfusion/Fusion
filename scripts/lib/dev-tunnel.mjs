/*
FNXC:DevTunnel 2026-08-18-23:40:
`pnpm dev --tunnel` exposes the dev server through a Cloudflare quick tunnel.

The case this exists for: someone working inside a remote Fusion (a container, a shared box) starts a
dev server there and needs to LOOK at it from their own browser. The dev server is bound inside that
machine, so without a tunnel the only options are port publishing or a VPN — both of which need
cooperation from whoever owns the host.

Cloudflare QUICK tunnels are the right tool precisely because a dev server is HTTP: they need no
account, no domain, and no card (the TCP endpoints that SSH would have required need all three).
The trade is that the hostname is random and lives only as long as the process.

NOT a production exposure path: the quick tunnel itself authenticates nobody. When it points at the
dashboard the dashboard's own bearer token is still the gate (see the banner note below); when it
points at any other port there is no gate at all, and the banner says so.
*/

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Cloudflare prints the assigned hostname once the edge accepts the tunnel. */
const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/** How long to wait for the URL before giving up and leaving the dev server running. */
const DEFAULT_URL_TIMEOUT_MS = 45_000;

export function extractQuickTunnelUrl(text) {
  const match = QUICK_TUNNEL_URL.exec(String(text ?? ""));
  return match ? match[0] : null;
}

/**
 * Start a Cloudflare quick tunnel for a local port.
 *
 * Resolves once the public URL is known, or with `url: null` if cloudflared never printed one —
 * the dev server keeps running either way, since losing the tunnel must not take the dev loop down.
 */
export async function startDevTunnel({
  port,
  auth,
  log = console,
  spawnFn = spawn,
  timeoutMs = DEFAULT_URL_TIMEOUT_MS,
} = {}) {
  if (!port) throw new Error("startDevTunnel requires a port");

  const child = spawnFn(
    "cloudflared",
    ["tunnel", "--no-autoupdate", "--url", `http://localhost:${port}`],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let settled = false;
  let url = null;

  const stop = () => {
    if (!child.killed) child.kill("SIGTERM");
  };

  const urlPromise = new Promise((resolve) => {
    const finish = (value) => {
      if (settled) return;
      settled = true;
      url = value;
      resolve(value);
    };

    const scan = (chunk) => {
      const found = extractQuickTunnelUrl(chunk);
      if (found) finish(found);
    };

    child.stdout?.on("data", scan);
    // cloudflared writes its banner (including the URL) to stderr.
    child.stderr?.on("data", scan);

    child.on("error", (error) => {
      const hint = error?.code === "ENOENT"
        ? "cloudflared is not installed — install it or drop --tunnel"
        : error?.message;
      log.error?.(`[fusion:dev] tunnel failed to start: ${hint}`);
      finish(null);
    });

    child.on("exit", (code) => {
      if (!settled) {
        log.error?.(`[fusion:dev] tunnel exited before publishing a URL (code ${code})`);
        finish(null);
      }
    });

    const timer = setTimeout(() => {
      if (!settled) {
        log.error?.(`[fusion:dev] tunnel did not publish a URL within ${Math.round(timeoutMs / 1000)}s`);
        finish(null);
      }
    }, timeoutMs);
    timer.unref?.();
  });

  await urlPromise;

  if (url) {
    printDevTunnelBanner({ url, port, auth, log });
  }

  return { url, stop, child };
}

/*
FNXC:DevTunnel 2026-08-19-01:18:
A tunnel URL alone is not usable when it points at the dashboard: the dashboard is bearer-token
gated, so the recipient lands on an auth wall with no token and the old banner's
"public, unauthenticated" line was actively wrong for the DEFAULT target. The banner now resolves
which of three states the tunnel is actually in and prints the matching thing:

  token       — dashboard with auth on: print the token AND a token-bearing URL, because handing
                someone a URL they cannot open is the whole failure this flag existed to avoid.
                The URL embeds the token deliberately (same shape as the local `fn serve` banner);
                that is safe for a link you hand to one person and is NOT the `/remote-login`
                redirect case, which leaked the daemon token to every recipient of a shared link.
  no-auth     — `--no-auth` was passed: the tunnel really is open, say so loudly.
  foreign     — the tunnel points at some other port (a Vite server, say). Fusion has no auth to
                lend it, so the unauthenticated warning is correct there and only there.
*/

/** Where the daemon token lives, mirroring core's resolveGlobalDir preference order. */
export function resolveGlobalSettingsFile(home = homedir(), exists = existsSync) {
  for (const dir of [join(home, ".fusion"), join(home, ".pi", "fusion"), join(home, ".pi", "kb")]) {
    if (exists(dir)) return join(dir, "settings.json");
  }
  return join(home, ".fusion", "settings.json");
}

function readStoredDaemonToken(settingsFile, read = readFileSync) {
  try {
    const parsed = JSON.parse(read(settingsFile, "utf8"));
    const token = parsed?.daemonToken;
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * Decide what auth (if any) the tunnel's target is behind.
 *
 * Pure apart from the injected readers so the three states are testable without a real dashboard,
 * a real `~/.fusion`, or a real cloudflared.
 */
export function resolveDevTunnelAuth({
  port,
  dashboardPort,
  args = [],
  env = process.env,
  settingsFile = resolveGlobalSettingsFile(),
  readToken = readStoredDaemonToken,
  reportedToken = null,
} = {}) {
  if (port !== dashboardPort) return { kind: "foreign" };
  if (args.includes("--no-auth")) return { kind: "no-auth" };

  /*
  FNXC:DevTunnel 2026-08-19-03:00:
  `reportedToken` is the token the dev server actually installed, handed over its IPC channel. It
  wins over every derived source because deriving was wrong: on a real run the token was not in
  ~/.fusion/settings.json at all, so the banner claimed none existed while the dashboard printed a
  working one directly above it. The env/file lookup remains for targets that report nothing.
  */
  const token = reportedToken
    ?? env.FUSION_DASHBOARD_TOKEN
    ?? env.FUSION_DAEMON_TOKEN
    ?? readToken(settingsFile);

  // No token on disk yet means the dev child is minting one right now (first authenticated run).
  // Predicting it is impossible, so point at the banner that will print it rather than guess.
  return token ? { kind: "token", token } : { kind: "token-pending" };
}

export function formatDevTunnelBanner({ url, port, auth }) {
  const lines = [`  ┌ dev server tunnel`, `  │ ${url}  →  http://localhost:${port}`];

  switch (auth?.kind) {
    case "token":
      lines.push(`  │ token: ${auth.token}`);
      lines.push(`  │ ready-to-open: ${url}/?token=${encodeURIComponent(auth.token)}`);
      lines.push(`  └ that link carries the token — share it only with whoever should have access`);
      break;
    case "token-pending":
      lines.push(`  └ append the ?token=… from the dashboard's own startup banner to open it`);
      break;
    case "no-auth":
      lines.push(`  └ --no-auth is on: anyone with this URL gets your dashboard, unauthenticated`);
      break;
    default:
      lines.push(`  └ anyone with this URL can reach that port — Fusion adds no auth to it`);
  }

  return lines;
}

function printDevTunnelBanner({ url, port, auth, log }) {
  log.log?.("");
  for (const line of formatDevTunnelBanner({ url, port, auth })) log.log?.(line);
  log.log?.("");
}
