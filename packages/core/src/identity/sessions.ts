/*
FNXC:Identity 2026-08-09-03:04:
U6 — DURABLE SESSIONS (R11, R12, R29, KTD5).

Three properties this module exists to provide, none of which the engine had before it:

1. DURABILITY (R11 / AE11). Everything session-shaped in the engine today is in-memory only, so a
   daemon restart silently logs everyone out. Sessions here live in `central.actor_sessions`, so a
   restart is invisible to a signed-in operator. The tests prove this by reopening the store rather
   than by trusting the write.

2. OPACITY WITHOUT PLAINTEXT AT REST (R11 / KTD5). The value handed to a client is a KTD4-shaped
   `fns_lookupid_secret` string; the database holds only the lookup id and an HMAC of the secret,
   via `./tokens.js`. R11's "opaque" guarantees unguessability, not at-rest protection — those are
   different properties and the second one is what the hash is for. Storing live bearer values in
   plaintext would upgrade the accepted "a local shell user reaches Postgres directly" residual from
   *reads data* to *impersonates any administrator over HTTP*, and a backup dump would carry the same
   power. Session verification deliberately reuses the FAST token path and never the password KDF.

3. TWO LIFETIME POLICIES, NOT ONE (R29). See {@link HUMAN_SESSION_POLICY} and
   {@link AGENT_SESSION_POLICY}. Collapsing them in either direction breaks something real: the human
   policy applied to an agent kills a multi-hour run mid-tool-call, and exempting agents from expiry
   altogether manufactures a non-expiring credential, which is the exact thing the whole authorization
   boundary rests on not existing.

R12 rotation is a first-class operation here rather than a caller convention: `startSession` revokes
any presented predecessor, and `rotateSessionForPrivilegeChange` exists so a role change cannot be
carried by a session id an attacker already holds.
*/

import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "../postgres/data-layer.js";
import { mintToken, parseToken, resolveTokenHmacKey, TOKEN_PREFIX, verifyTokenSecret } from "./tokens.js";

/** A query-capable handle: either the top-level db or a transaction handle. */
type QueryHandle = AsyncDataLayer["db"] | DbTransaction;
/*
FNXC:Identity 2026-08-15-06:20 (review finding — rotation was not atomic):
Rotation REVOKES the predecessor and then INSERTS the successor. With only `db` available these ran
as two independent statements, so a failure between them left the operator holding a revoked session
with no replacement — and because a privilege change is exactly what triggers rotation, the failure
mode was "role updated, user permanently logged out, no retry can recover the revoked row".

`transactionImmediate` is optional so a caller passing a minimal layer (tests, a plain db handle)
still type-checks; when it is absent the previous non-atomic behaviour is used rather than crashing,
and when a `handle` is supplied the caller already owns the transaction.
*/
type SessionLayer = Pick<AsyncDataLayer, "db"> & Partial<Pick<AsyncDataLayer, "transactionImmediate">>;

/** R29's split. Mirrors the `actor_sessions_kind_check` CHECK constraint — the two must not drift. */
export type SessionKind = "human" | "agent";

/** The persisted session row, minus the secret (which exists only in the value handed to the client). */
export interface ActorSession {
  id: string;
  actorId: string;
  lookupId: string;
  kind: SessionKind;
  issuedAt: string;
  /** Null for agent sessions — R29: an agent is idle by design between heartbeats. */
  idleExpiresAt: string | null;
  absoluteExpiresAt: string;
  revokedAt: string | null;
  providerId: string | null;
}

interface SessionRow extends Omit<ActorSession, "kind"> {
  kind: string;
  secretHash: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/*
FNXC:Identity 2026-08-09-03:04:
R12 — THE HUMAN IDLE DEFAULT IS DELIBERATELY LONG.

The primary workflow this product is hired for is checking in on running agents from whatever device
is nearby: laptop at the desk, phone from the couch, laptop again the next morning. A conventional
30-minute idle timeout taxes exactly that behaviour — every check-in from the other device becomes a
password prompt, which is a tax on the product's core loop and, predictably, the thing that gets
disabled first. Seven days of idle survives a holiday weekend and a week of not looking; the absolute
timeout at fourteen days is the backstop that keeps a forgotten session from living forever.

The REMEMBERED-DEVICE path is what makes the returning-mobile case pleasant: an explicitly trusted
device gets a thirty-day idle window and a ninety-day absolute one, so a phone opened after three
weeks resumes rather than re-prompting. It is opt-in per login precisely because "remember this
device" is a user statement about the device's physical security, not something to infer.
*/
export const HUMAN_SESSION_POLICY = {
  idleMs: 7 * DAY,
  absoluteMs: 14 * DAY,
  rememberedDeviceIdleMs: 30 * DAY,
  rememberedDeviceAbsoluteMs: 90 * DAY,
} as const;

/*
FNXC:Identity 2026-08-09-03:04:
R29 — THE AGENT POLICY IS STRUCTURALLY DIFFERENT, NOT JUST LONGER.

No idle timeout at all (`idleExpiresAt` is NULL): an agent is idle by design between heartbeats, so
idleness carries no information about whether the credential is still wanted. The absolute lifetime
is bounded by the RUN, supplied by the caller and capped here, and renewable in-run
({@link renewAgentSession}) so a run that outlives its initial estimate extends rather than dying
mid-tool-call. What replaces expiry as the containment mechanism is REVOCATION CHECKED AT EVERY TOOL
CALL ({@link authorizeAgentToolCall}) — an operator revoking an agent stops it at its next tool call,
in seconds, instead of whenever a timer would have fired.

The cap matters: without `maxLifetimeMs` a caller could pass a run duration of a year and
manufacture the non-expiring credential the boundary rests on not existing. It is set above the human
absolute window on purpose — a long batch run legitimately outlives a human session, and that is the
concrete difference AE25 asserts.
*/
export const AGENT_SESSION_POLICY = {
  idleMs: null,
  defaultRunMs: 12 * HOUR,
  maxLifetimeMs: 30 * DAY,
} as const;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function ms(value: string): number {
  return Date.parse(value);
}

function rowToSession(row: SessionRow): ActorSession {
  return {
    id: row.id,
    actorId: row.actorId,
    lookupId: row.lookupId,
    kind: row.kind as SessionKind,
    issuedAt: row.issuedAt,
    idleExpiresAt: row.idleExpiresAt,
    absoluteExpiresAt: row.absoluteExpiresAt,
    revokedAt: row.revokedAt,
    providerId: row.providerId,
  };
}

export interface CreateSessionInput {
  actorId: string;
  kind: SessionKind;
  providerId?: string | null;
  /** Human sessions only. Opt-in per login; grants the long idle/absolute windows (R12). */
  rememberDevice?: boolean;
  /** Agent sessions only. The run's expected duration; capped at {@link AGENT_SESSION_POLICY.maxLifetimeMs}. */
  runDurationMs?: number;
  now?: string;
  /** Server HMAC key override; defaults to the resolved pepper (see `./tokens.js`). */
  hmacKey?: Buffer | string;
}

/** A newly issued session plus the opaque value handed to the client exactly once. */
export interface IssuedSession {
  session: ActorSession;
  /** `fns_lookupid_secret`. Never persisted, never logged. */
  token: string;
}

/**
 * FNXC:Identity 2026-08-09-03:04:
 * Issue a session. Human sessions get both windows; agent sessions get `idleExpiresAt = NULL` and an
 * absolute bound derived from the run duration (R29). Only the lookup id and the HMAC of the secret
 * are written — the token itself exists only in the return value.
 */
export async function createSession(
  layer: SessionLayer,
  input: CreateSessionInput,
  handle?: QueryHandle,
): Promise<IssuedSession> {
  const db = handle ?? layer.db;
  const nowIso = input.now ?? new Date().toISOString();
  const now = ms(nowIso);
  const key = resolveTokenHmacKey(input.hmacKey);
  const minted = mintToken(TOKEN_PREFIX.session, key);

  let idleExpiresAt: string | null;
  let absoluteExpiresAt: string;
  if (input.kind === "agent") {
    const requested = input.runDurationMs ?? AGENT_SESSION_POLICY.defaultRunMs;
    const bounded = Math.min(Math.max(requested, 0), AGENT_SESSION_POLICY.maxLifetimeMs);
    idleExpiresAt = null;
    absoluteExpiresAt = iso(now + bounded);
  } else {
    const idleMs = input.rememberDevice
      ? HUMAN_SESSION_POLICY.rememberedDeviceIdleMs
      : HUMAN_SESSION_POLICY.idleMs;
    const absoluteMs = input.rememberDevice
      ? HUMAN_SESSION_POLICY.rememberedDeviceAbsoluteMs
      : HUMAN_SESSION_POLICY.absoluteMs;
    idleExpiresAt = iso(now + idleMs);
    absoluteExpiresAt = iso(now + absoluteMs);
  }

  const row: SessionRow = {
    id: `sess-${randomUUID()}`,
    actorId: input.actorId,
    lookupId: minted.lookupId,
    secretHash: minted.secretHash,
    kind: input.kind,
    issuedAt: nowIso,
    idleExpiresAt,
    absoluteExpiresAt,
    revokedAt: null,
    providerId: input.providerId ?? null,
  };
  await db.insert(schema.central.actorSessions).values(row);
  return { session: rowToSession(row), token: minted.token };
}

export type SessionRejectionReason =
  | "malformed"
  | "not-found"
  | "bad-secret"
  | "revoked"
  | "idle-expired"
  | "absolute-expired";

export type SessionVerification =
  | { ok: true; session: ActorSession }
  | { ok: false; reason: SessionRejectionReason };

export interface VerifySessionOptions {
  now?: string;
  hmacKey?: Buffer | string;
  /**
   * Slide the human idle window on a successful verification (default true). Pass false for a probe
   * that must not count as activity.
   */
  slideIdle?: boolean;
}

/**
 * FNXC:Identity 2026-08-09-03:04:
 * The idle window a human session was issued under, recovered from the row rather than from a column.
 *
 * `actor_sessions` has no "remembered device" flag and migration 0047 is already landed, so the flag
 * is derived from the ABSOLUTE lifetime, which is the one human field that never changes after issue:
 * a session whose total absolute span reaches the remembered-device span was issued as one. Deriving
 * from `idleExpiresAt` instead would be wrong — that value moves every time the window slides.
 */
function humanIdleWindowMs(row: Pick<ActorSession, "issuedAt" | "absoluteExpiresAt">): number {
  const totalMs = ms(row.absoluteExpiresAt) - ms(row.issuedAt);
  return totalMs >= HUMAN_SESSION_POLICY.rememberedDeviceAbsoluteMs
    ? HUMAN_SESSION_POLICY.rememberedDeviceIdleMs
    : HUMAN_SESSION_POLICY.idleMs;
}

async function loadSessionByLookupId(
  db: QueryHandle,
  lookupId: string,
): Promise<SessionRow | undefined> {
  const rows = await db
    .select()
    .from(schema.central.actorSessions)
    .where(eq(schema.central.actorSessions.lookupId, lookupId))
    .limit(1);
  return rows[0] as SessionRow | undefined;
}

/**
 * FNXC:Identity 2026-08-09-03:04:
 * Verify a presented session value.
 *
 * The order of checks is the security-relevant part. Parse first, so a garbage bearer header costs no
 * query at all. Then ONE indexed lookup on the unique `lookup_id` — never a scan over hashes (KTD4).
 * Then the constant-time secret compare. Revocation is checked BEFORE expiry so a revoked-and-expired
 * session reports the operator-meaningful reason. Absolute expiry is checked before idle expiry
 * because the absolute bound is the one that cannot be extended by activity.
 *
 * On success, a human session's idle window slides forward, clamped to the absolute expiry so sliding
 * can never push a session past the bound it was issued with. Agent sessions have no idle window to
 * slide (R29) and are untouched by this path.
 */
export async function verifySession(
  layer: SessionLayer,
  token: string,
  options?: VerifySessionOptions,
  handle?: QueryHandle,
): Promise<SessionVerification> {
  const db = handle ?? layer.db;
  const parsed = parseToken(token, TOKEN_PREFIX.session);
  if (!parsed) return { ok: false, reason: "malformed" };

  const row = await loadSessionByLookupId(db, parsed.lookupId);
  if (!row) return { ok: false, reason: "not-found" };

  const key = resolveTokenHmacKey(options?.hmacKey);
  if (!verifyTokenSecret(parsed.secret, row.secretHash, key)) return { ok: false, reason: "bad-secret" };

  if (row.revokedAt) return { ok: false, reason: "revoked" };

  const nowIso = options?.now ?? new Date().toISOString();
  const now = ms(nowIso);
  if (now >= ms(row.absoluteExpiresAt)) return { ok: false, reason: "absolute-expired" };
  if (row.idleExpiresAt && now >= ms(row.idleExpiresAt)) return { ok: false, reason: "idle-expired" };

  const session = rowToSession(row);
  if (session.kind === "human" && options?.slideIdle !== false) {
    const slid = Math.min(now + humanIdleWindowMs(session), ms(session.absoluteExpiresAt));
    const nextIdle = iso(slid);
    if (nextIdle !== session.idleExpiresAt) {
      await db
        .update(schema.central.actorSessions)
        .set({ idleExpiresAt: nextIdle })
        .where(eq(schema.central.actorSessions.id, session.id));
      session.idleExpiresAt = nextIdle;
    }
  }
  return { ok: true, session };
}

/**
 * FNXC:Identity 2026-08-09-03:04:
 * R29 — the agent authorization check that runs at EVERY TOOL CALL.
 *
 * This is what stands in for expiry on the agent path. It is a separate entry point from
 * {@link verifySession} so the call site reads as what it is, and so it can never silently acquire
 * the human idle policy: it asserts the session's kind and refuses a human session outright rather
 * than authorizing one under agent rules.
 *
 * The expensive-sounding part is a single indexed lookup plus an HMAC compare (KTD4) — cheap enough
 * to run on every tool call, which is the entire reason revocation-at-tool-call is a viable policy.
 */
export async function authorizeAgentToolCall(
  layer: SessionLayer,
  token: string,
  options?: { now?: string; hmacKey?: Buffer | string },
  handle?: QueryHandle,
): Promise<SessionVerification> {
  const result = await verifySession(layer, token, { ...options, slideIdle: false }, handle);
  if (!result.ok) return result;
  if (result.session.kind !== "agent") return { ok: false, reason: "bad-secret" };
  return result;
}

/**
 * FNXC:Identity 2026-08-09-03:04:
 * R29 in-run renewal: extend an agent session's absolute bound as a long run continues, capped at
 * `issuedAt + maxLifetimeMs` so renewal can extend a run but never manufacture a perpetual
 * credential. A revoked session is never renewed — renewal must not resurrect what an operator killed.
 */
export async function renewAgentSession(
  layer: SessionLayer,
  sessionId: string,
  options?: { runDurationMs?: number; now?: string },
  handle?: QueryHandle,
): Promise<ActorSession | null> {
  const db = handle ?? layer.db;
  const rows = await db
    .select()
    .from(schema.central.actorSessions)
    .where(eq(schema.central.actorSessions.id, sessionId))
    .limit(1);
  const row = rows[0] as SessionRow | undefined;
  if (!row || row.kind !== "agent" || row.revokedAt) return null;

  const nowIso = options?.now ?? new Date().toISOString();
  const now = ms(nowIso);
  /*
  FNXC:Identity 2026-08-24-02:20 (review finding — renewal must not resurrect a dead session):
  `verifySession` already rejects `absolute-expired`. Renewal that writes a later
  `absoluteExpiresAt` after that bound would revive a credential the absolute cap exists to
  contain. Treat expiry like revocation: the session stays dead.
  */
  if (now >= ms(row.absoluteExpiresAt)) return null;
  const requested = options?.runDurationMs ?? AGENT_SESSION_POLICY.defaultRunMs;
  const ceiling = ms(row.issuedAt) + AGENT_SESSION_POLICY.maxLifetimeMs;
  const extended = Math.min(now + Math.max(requested, 0), ceiling);
  const next = Math.max(extended, ms(row.absoluteExpiresAt));
  const absoluteExpiresAt = iso(next);
  await db
    .update(schema.central.actorSessions)
    .set({ absoluteExpiresAt })
    .where(eq(schema.central.actorSessions.id, sessionId));
  return { ...rowToSession(row), absoluteExpiresAt };
}

/** Revoke one session by id. Idempotent: revoking an already-revoked session keeps the first timestamp. */
export async function revokeSession(
  layer: SessionLayer,
  sessionId: string,
  now = new Date().toISOString(),
  handle?: QueryHandle,
): Promise<void> {
  const db = handle ?? layer.db;
  await db
    .update(schema.central.actorSessions)
    .set({ revokedAt: now })
    .where(
      and(
        eq(schema.central.actorSessions.id, sessionId),
        isNull(schema.central.actorSessions.revokedAt),
      ),
    );
}

/** Look a session up by its id (diagnostics, administration, and the rotation assertions). */
export async function getSession(
  layer: SessionLayer,
  sessionId: string,
  handle?: QueryHandle,
): Promise<ActorSession | null> {
  const db = handle ?? layer.db;
  const rows = await db
    .select()
    .from(schema.central.actorSessions)
    .where(eq(schema.central.actorSessions.id, sessionId))
    .limit(1);
  const row = rows[0] as SessionRow | undefined;
  return row ? rowToSession(row) : null;
}

/**
 * FNXC:Identity 2026-08-09-03:04:
 * R12 — LOGIN ROTATES THE SESSION ID.
 *
 * A successful login always issues a NEW session id and revokes whatever session the client presented
 * on the way in. That is the session-fixation defence: an attacker who plants a session value (the
 * `?token=` capture path KTD5 flags as fixation-prone until it validates before storing) must not end
 * up holding a value that becomes authenticated when the victim logs in.
 *
 * Revoking the predecessor rather than leaving it alive is the second half — a rotated-away session
 * that still verifies is not a rotation, it is a second credential.
 */
export async function startSession(
  layer: SessionLayer,
  input: CreateSessionInput & { previousSessionId?: string | null },
  handle?: QueryHandle,
): Promise<IssuedSession> {
  // Same atomicity requirement as rotation: revoking the predecessor and creating the successor is
  // one operation, or a failed login leaves the caller with neither session.
  if (!handle && input.previousSessionId && layer.transactionImmediate) {
    return layer.transactionImmediate((tx) =>
      startSession(layer, input, tx as QueryHandle),
    ) as Promise<IssuedSession>;
  }
  const nowIso = input.now ?? new Date().toISOString();
  if (input.previousSessionId) {
    await revokeSession(layer, input.previousSessionId, nowIso, handle);
  }
  return createSession(layer, { ...input, now: nowIso }, handle);
}

/**
 * FNXC:Identity 2026-08-09-03:04:
 * R12 — PRIVILEGE CHANGE ROTATES THE SESSION ID.
 *
 * A role grant or revocation must not be carried by a session id that existed before the change. The
 * new session inherits the predecessor's kind, provider, `issuedAt`, and absolute expiry rather than
 * restarting the clock: a role change is not a login, and silently extending the absolute lifetime on
 * every grant would let frequent privilege edits keep one session alive indefinitely. Carrying
 * `issuedAt` forward is also what keeps {@link humanIdleWindowMs} correct across a rotation — that
 * derivation reads the total issued-to-absolute span, so resetting `issuedAt` to now would silently
 * demote a remembered device back to the short idle window.
 *
 * Returns null when the predecessor is missing or already revoked — there is nothing to rotate, and
 * minting a session for a revoked predecessor would undo the revocation.
 */
export async function rotateSessionForPrivilegeChange(
  layer: SessionLayer,
  sessionId: string,
  options?: { now?: string; hmacKey?: Buffer | string },
  handle?: QueryHandle,
): Promise<IssuedSession | null> {
  // Own the unit of work when the caller did not: revoke+insert must not half-apply.
  if (!handle && layer.transactionImmediate) {
    return layer.transactionImmediate((tx) =>
      rotateSessionForPrivilegeChange(layer, sessionId, options, tx as QueryHandle),
    ) as Promise<IssuedSession | null>;
  }
  const db = handle ?? layer.db;
  const existing = await getSession(layer, sessionId, handle);
  if (!existing || existing.revokedAt) return null;

  const nowIso = options?.now ?? new Date().toISOString();
  const now = ms(nowIso);
  const remainingAbsoluteMs = Math.max(ms(existing.absoluteExpiresAt) - now, 0);

  await revokeSession(layer, sessionId, nowIso, handle);

  const key = resolveTokenHmacKey(options?.hmacKey);
  const minted = mintToken(TOKEN_PREFIX.session, key);
  const idleExpiresAt =
    existing.kind === "agent"
      ? null
      : iso(Math.min(now + humanIdleWindowMs(existing), now + remainingAbsoluteMs));
  const row: SessionRow = {
    id: `sess-${randomUUID()}`,
    actorId: existing.actorId,
    lookupId: minted.lookupId,
    secretHash: minted.secretHash,
    kind: existing.kind,
    issuedAt: existing.issuedAt,
    idleExpiresAt,
    absoluteExpiresAt: existing.absoluteExpiresAt,
    revokedAt: null,
    providerId: existing.providerId,
  };
  await db.insert(schema.central.actorSessions).values(row);
  return { session: rowToSession(row), token: minted.token };
}

/** Live (non-revoked) sessions for an actor. */
export async function listSessionsForActor(
  layer: SessionLayer,
  actorId: string,
  handle?: QueryHandle,
): Promise<ActorSession[]> {
  const db = handle ?? layer.db;
  const rows = (await db
    .select()
    .from(schema.central.actorSessions)
    .where(
      and(
        eq(schema.central.actorSessions.actorId, actorId),
        isNull(schema.central.actorSessions.revokedAt),
      ),
    )) as SessionRow[];
  return rows.map(rowToSession);
}
