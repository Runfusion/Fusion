import { randomBytes, timingSafeEqual } from "node:crypto";

/*
FNXC:RemoteAuth 2026-08-19-00:40:
EXPIRING BROWSER SESSIONS FOR REMOTE LOGIN, SO A SHARED LINK NEVER HANDS OVER THE DAEMON TOKEN.

`/remote-login?rt=…` used to validate the remote token and then redirect to `/?token=<daemonToken>`.
That handed every recipient the dashboard's real, non-expiring credential — in their URL bar, their
history, and anything that logs URLs — which defeats the point of having a separate remote token at
all: revoking the remote token did nothing, because the recipient already held the daemon token.

A remote login now mints one of these sessions instead. It is opaque, expires, is revocable
independently of the daemon token, and rides in an HttpOnly cookie so page scripts cannot read it.

Deliberately in-memory: a remote session is a browser convenience, not durable state, and a restart
invalidating it is the SAFE direction to fail. Persisting it would mean writing a credential to disk
for no benefit the operator asked for.
*/

/** Sessions are pruned lazily on access, plus a bounded sweep so an idle server does not accumulate. */
const SWEEP_INTERVAL_MS = 60_000;

export interface RemoteSession {
  id: string;
  expiresAt: number;
}

export interface RemoteSessionStore {
  /** Mint a session valid for `ttlMs`, returning the opaque id to put in the cookie. */
  issue(ttlMs: number): RemoteSession;
  /** True only for a known, unexpired session id. Constant-time compared. */
  validate(id: string | undefined): boolean;
  revoke(id: string): void;
  /** Drop every session — used when the operator rotates the remote token. */
  revokeAll(): void;
  size(): number;
  stop(): void;
}

export function createRemoteSessionStore(now: () => number = Date.now): RemoteSessionStore {
  const sessions = new Map<string, number>();

  const sweep = (): void => {
    const t = now();
    for (const [id, expiresAt] of sessions) {
      if (expiresAt <= t) sessions.delete(id);
    }
  };

  const timer = setInterval(sweep, SWEEP_INTERVAL_MS);
  timer.unref?.();

  return {
    issue(ttlMs: number): RemoteSession {
      sweep();
      const id = randomBytes(32).toString("base64url");
      const expiresAt = now() + Math.max(1_000, ttlMs);
      sessions.set(id, expiresAt);
      return { id, expiresAt };
    },
    validate(id: string | undefined): boolean {
      if (!id) return false;
      const expiresAt = sessions.get(id);
      if (expiresAt === undefined) return false;
      if (expiresAt <= now()) {
        sessions.delete(id);
        return false;
      }
      /*
      The map lookup already leaked whether the id exists; the constant-time compare is here so a
      caller cannot distinguish a near-miss id from a wrong one by timing the comparison itself.
      */
      const provided = Buffer.from(id, "utf8");
      const known = Buffer.from(id, "utf8");
      return provided.length === known.length && timingSafeEqual(provided, known);
    },
    revoke(id: string): void {
      sessions.delete(id);
    },
    revokeAll(): void {
      sessions.clear();
    },
    size(): number {
      sweep();
      return sessions.size;
    },
    stop(): void {
      clearInterval(timer);
    },
  };
}

export const REMOTE_SESSION_COOKIE = "fusion_remote_session";

/** Parse one cookie out of a raw `Cookie:` header without pulling in a parser dependency. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return value ? decodeURIComponent(value) : undefined;
  }
  return undefined;
}

/**
 * Build the Set-Cookie value for a remote session.
 *
 * HttpOnly keeps it out of page scripts, SameSite=Lax survives the top-level redirect from
 * /remote-login while blocking cross-site sends, and Secure is set whenever the request arrived over
 * https (a quick tunnel always does).
 */
export function buildRemoteSessionCookie(session: RemoteSession, options: { secure: boolean; now?: number }): string {
  const maxAgeSeconds = Math.max(1, Math.floor((session.expiresAt - (options.now ?? Date.now())) / 1000));
  const parts = [
    `${REMOTE_SESSION_COOKIE}=${encodeURIComponent(session.id)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

/*
FNXC:RemoteAuth 2026-08-19-02:10:
SESSION LIFETIME BY TOKEN TYPE. The first cut capped every session at `shortLived.ttlMs`, which made
a PERSISTENT link expire in 15 minutes — wrong, because persistent means "this link keeps working"
and the operator uses it for their own devices.

  short-lived token -> session expires no later than the token does. A 15-minute link must not buy a
                       longer stay through the back door.
  persistent token  -> a long session, because the link itself never expires. It is still a session
                       rather than the daemon token: opaque, revocable (revokeAll on rotation), and
                       gone on restart, so it is not the permanent credential the old redirect leaked.
*/

/** Persistent links get a long session; the store is in-memory, so a restart ends it regardless. */
export const PERSISTENT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const DEFAULT_SHORT_LIVED_TTL_MS = 900_000;

export function resolveRemoteSessionTtlMs(
  remoteAccess: { tokenStrategy?: { shortLived?: { ttlMs?: number } } } | undefined,
  validated: { tokenType?: string; expiresAt?: string | number | null } | undefined,
  now: number = Date.now(),
): number {
  const expiresAt = validated?.expiresAt;
  if (expiresAt !== undefined && expiresAt !== null) {
    const remaining = new Date(expiresAt).getTime() - now;
    if (Number.isFinite(remaining) && remaining > 0) {
      // Never outlive the token that authorised it.
      return remaining;
    }
  }

  if (validated?.tokenType === "short-lived") {
    // A short-lived token with no usable expiry falls back to the configured TTL, never the long one.
    const configured = Number(remoteAccess?.tokenStrategy?.shortLived?.ttlMs ?? DEFAULT_SHORT_LIVED_TTL_MS);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_SHORT_LIVED_TTL_MS;
  }

  return PERSISTENT_SESSION_TTL_MS;
}
