/*
FNXC:EventDrivenDispatch 2026-09-18-00:40:
FN-519 — cross-process transport for the advisory dispatch-wake signal, over PostgreSQL
`LISTEN/NOTIFY`.

Why NOTIFY and not a durable queue: the durable row (task, workflow work item) already IS the
queue. A wake only tells an engine "look now", so it may be lost without losing work — which is
exactly what NOTIFY guarantees and does not guarantee:

  * delivered only AFTER the publishing transaction commits, and never after a rollback
    (https://www.postgresql.org/docs/15/sql-notify.html) — so a wake cannot advertise work a peer
    cannot yet see;
  * LISTEN must be in place before the read that the listener relies on, and a wake published while
    disconnected is simply gone (https://www.postgresql.org/docs/15/sql-listen.html) — hence the
    catch-up read after LISTEN and after every reconnect, and hence the periodic sweeps staying as
    the recovery backstop.

Connection discipline, and what each rule prevents:

  * the listening session is a DEDICATED connection with `max: 1`, obtained from the proven DIRECT
    session target (`backend.directSessionUrl`, the same provenance the planning lifecycle advisory
    lock requires). A transaction pooler may move a session between statements, which silently
    breaks both session advisory locks and LISTEN registration, so a pooler URL is refused rather
    than used;
  * it is NEVER taken from the runtime mutation pool (max 3). A long-lived LISTEN would permanently
    hold a third of the mutation budget;
  * one connection per (runtime, project) — never per card and never per signal;
  * a missing direct target or a failed LISTEN degrades to an explicitly NAMED diagnostic and keeps
    the durable rows plus existing periodic recovery. It never falls back to the pooler and never
    fails the mutation that published.

Payload discipline: channel `fusion_dispatch_wake` carries a compact JSON object of ids and bounded
enums only (`p` project, `r` reason, `t` optional task id). NOTIFY payloads are visible to every
user of the database and are capped at 8000 bytes by the server, so prompts, titles, task content,
connection URLs, and secrets must never appear — and the payload is deliberately too small to hold
them. A malformed or oversized payload is dropped in favour of a project-only wake, because a
missed wake is a stall while a spurious wake is one bounded no-op pass.
*/

import { sql } from "drizzle-orm";
import postgres from "postgres";

import type { DispatchWakeEvent, DispatchWakeReason } from "../dispatch-wake.js";
import { looksLikePoolerUrl } from "./backend-resolver.js";

/** The single NOTIFY channel. Lowercase and unquoted so it needs no identifier quoting. */
export const DISPATCH_WAKE_CHANNEL = "fusion_dispatch_wake";

/** Hard cap well under PostgreSQL's 8000-byte NOTIFY payload limit. */
export const DISPATCH_WAKE_MAX_PAYLOAD_BYTES = 512;

const VALID_REASONS: ReadonlySet<string> = new Set<DispatchWakeReason>([
  "task-eligibility",
  "continuation",
  "capacity",
  "settings",
  "release",
]);

export interface DispatchWakeTransportTarget {
  /** The proven direct (non-pooler) session URL; see `backend-resolver`'s `directSessionUrl`. */
  readonly directSessionUrl?: string | null;
  readonly directSessionProvenance?: string | null;
}

export type DispatchWakeTransportAvailability =
  | { available: true; directSessionUrl: string }
  | { available: false; reason: "direct-session-unavailable" | "pooler-target-refused" };

/**
 * Side-effect-free availability check, exported so a caller can NAME the degraded mode before
 * attempting any connection. Mirrors `planningLifecycleLockTransportAvailability` on purpose: both
 * need a session whose identity survives across statements, and a pooler provides neither.
 */
export function dispatchWakeTransportAvailability(
  target: DispatchWakeTransportTarget,
): DispatchWakeTransportAvailability {
  const directUrl = target.directSessionUrl;
  if (!directUrl || !target.directSessionProvenance) {
    return { available: false, reason: "direct-session-unavailable" };
  }
  if (looksLikePoolerUrl(directUrl)) return { available: false, reason: "pooler-target-refused" };
  return { available: true, directSessionUrl: directUrl };
}

/** Serialize a wake to the bounded ids-only payload, or null when it cannot be represented. */
export function encodeDispatchWakePayload(event: DispatchWakeEvent): string | null {
  if (!event.projectId || !VALID_REASONS.has(event.reason)) return null;
  const payload = JSON.stringify({
    p: event.projectId,
    r: event.reason,
    ...(event.taskId ? { t: event.taskId } : {}),
  });
  // Oversized is dropped rather than truncated: a truncated JSON payload would decode to nothing
  // useful, and the publisher is better served by the project-only fallback the decoder provides.
  if (Buffer.byteLength(payload, "utf8") > DISPATCH_WAKE_MAX_PAYLOAD_BYTES) return null;
  return payload;
}

/**
 * Decode a received payload. Returns null for anything unusable.
 *
 * A wake from a NEWER publisher with an unknown reason is deliberately accepted and normalized to
 * `task-eligibility`, because the consumer's response to an unknown reason is "run the authoritative
 * passes" — dropping it would turn a forward-compatible signal into a stall.
 */
export function decodeDispatchWakePayload(payload: string): DispatchWakeEvent | null {
  if (!payload || Buffer.byteLength(payload, "utf8") > DISPATCH_WAKE_MAX_PAYLOAD_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const raw = parsed as { p?: unknown; r?: unknown; t?: unknown };
  if (typeof raw.p !== "string" || raw.p.length === 0) return null;
  const reason = typeof raw.r === "string" && VALID_REASONS.has(raw.r)
    ? (raw.r as DispatchWakeReason)
    : "task-eligibility";
  return {
    projectId: raw.p,
    reason,
    ...(typeof raw.t === "string" && raw.t.length > 0 ? { taskId: raw.t } : {}),
    remote: true,
  };
}

export interface DispatchWakeListenerHandle {
  /** Stop listening and close the dedicated connection. Idempotent. */
  dispose(): Promise<void>;
  /** Diagnostics: whether the dedicated session is currently registered. */
  readonly listening: boolean;
}

export interface StartDispatchWakeListenerOptions {
  readonly target: DispatchWakeTransportTarget;
  /**
   * The project this runtime serves. Used ONLY as the scope of the fallback wake emitted when a
   * payload cannot be decoded, so an unreadable signal still reaches the authoritative passes
   * instead of being dropped. Decodable payloads always carry their own project id, and a payload
   * naming a DIFFERENT project is delivered with that project's id so the consumer's own
   * project-scoped subscription filters it — the channel is shared, the routing is not.
   */
  readonly projectId: string;
  /** Called for each decoded remote wake. Must not throw; failures are absorbed here anyway. */
  readonly onWake: (event: DispatchWakeEvent) => void;
  /**
   * Catch-up read, run right AFTER the LISTEN registration succeeds and after every reconnect.
   * NOTIFY delivers nothing for the disconnected window, so without this a reconnecting engine
   * would silently skip whatever landed while it was away.
   */
  readonly onCatchUp?: (origin: "listen" | "reconnect") => void;
  readonly warn?: (message: string) => void;
  /** Injectable driver factory so a test can drive LISTEN/notify/reconnect deterministically. */
  readonly connect?: (url: string) => DispatchWakeListenClient;
}

/** The narrow slice of the postgres.js client this transport uses. */
export interface DispatchWakeListenClient {
  listen(
    channel: string,
    onNotify: (payload: string) => void,
    onListen?: () => void,
  ): Promise<{ unlisten: () => Promise<void> } | void>;
  end(options?: { timeout?: number }): Promise<void>;
}

/** One dedicated, bounded listening session per (runtime, project). */
export async function startDispatchWakeListener(
  options: StartDispatchWakeListenerOptions,
): Promise<DispatchWakeListenerHandle | { degraded: string }> {
  const availability = dispatchWakeTransportAvailability(options.target);
  if (!availability.available) {
    return { degraded: `dispatch-wake transport unavailable: ${availability.reason}` };
  }

  const connect = options.connect
    ?? ((url: string) => postgres(url, {
      max: 1,
      prepare: false,
      onnotice: () => {},
    }) as unknown as DispatchWakeListenClient);

  let client: DispatchWakeListenClient;
  try {
    client = connect(availability.directSessionUrl);
  } catch (error) {
    return { degraded: `dispatch-wake transport could not open a session: ${errorText(error)}` };
  }

  let listening = false;
  let disposed = false;
  let unlisten: (() => Promise<void>) | undefined;
  let listenCount = 0;

  try {
    const registration = await client.listen(
      DISPATCH_WAKE_CHANNEL,
      (payload: string) => {
        if (disposed) return;
        const decoded = decodeDispatchWakePayload(payload);
        try {
          // A payload we cannot read still proves SOMETHING changed, so fall back to waking this
          // runtime's own project with no task scope rather than dropping the signal.
          options.onWake(decoded ?? {
            projectId: options.projectId,
            reason: "task-eligibility",
            remote: true,
          });
        } catch (error) {
          options.warn?.(`dispatch-wake remote delivery failed: ${errorText(error)}`);
        }
      },
      () => {
        // postgres.js re-invokes onlisten on reconnect, which is the only signal that the
        // disconnected window happened at all.
        listening = true;
        listenCount += 1;
        if (disposed) return;
        try {
          options.onCatchUp?.(listenCount === 1 ? "listen" : "reconnect");
        } catch (error) {
          options.warn?.(`dispatch-wake catch-up failed: ${errorText(error)}`);
        }
      },
    );
    if (registration && typeof registration.unlisten === "function") {
      unlisten = registration.unlisten;
    }
  } catch (error) {
    await client.end({ timeout: 1 }).catch(() => undefined);
    return { degraded: `dispatch-wake transport could not LISTEN: ${errorText(error)}` };
  }

  return {
    get listening() {
      return listening && !disposed;
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      listening = false;
      // Unlisten first so a late notification cannot reach a disposed consumer, then release the
      // connection — a leaked LISTEN session is a permanent connection held for a dead runtime.
      await Promise.resolve(unlisten?.()).catch(() => undefined);
      await client.end({ timeout: 2 }).catch(() => undefined);
    },
  };
}

/** The narrow slice of a Drizzle transaction/handle this transport publishes through. */
export interface DispatchWakeNotifyHandle {
  execute(query: unknown): Promise<unknown>;
}

/**
 * Publish a wake THROUGH THE CALLER'S OWN TRANSACTION HANDLE.
 *
 * FNXC:EventDrivenDispatch 2026-09-18-00:40:
 * This is the commit-correctness mechanism, and it is the server's, not ours. `NOTIFY` issued
 * inside a transaction is delivered only once that transaction COMMITS, and is discarded entirely
 * on rollback (https://www.postgresql.org/docs/15/sql-notify.html). So writing the wake on the same
 * handle as the row gives the exact contract the continuation writers need for free:
 *
 *   * no consumer can observe a wake for a row it cannot yet read — including when the caller
 *     threaded an EXTERNAL transaction that commits much later;
 *   * a rolled-back write, or a lost compare-and-set that returns before this call, publishes
 *     nothing at all;
 *   * the notification never creates work: the durable row stays the single source of truth, and a
 *     lost wake can only delay, which the periodic sweeps still recover.
 *
 * It also means we do NOT need an after-commit callback plumbed through every nested-transaction
 * caller, which would have been a second, weaker implementation of a guarantee the database
 * already makes.
 *
 * Failure is swallowed: a wake is advisory, so it must never be able to roll back the mutation it
 * describes.
 */
export async function notifyDispatchWakeWithinTransaction(
  handle: DispatchWakeNotifyHandle,
  event: DispatchWakeEvent,
  warn?: (message: string) => void,
): Promise<void> {
  const payload = encodeDispatchWakePayload(event);
  if (!payload) return;
  try {
    await handle.execute(sql`SELECT pg_notify(${DISPATCH_WAKE_CHANNEL}, ${payload})`);
  } catch (error) {
    warn?.(`dispatch-wake notify failed: ${errorText(error)}`);
  }
}

function errorText(error: unknown): string {
  // Driver connection errors can carry endpoint credentials; keep only the message text and let
  // callers redact. Never attach the original error as `cause` on an operator-visible diagnostic.
  return error instanceof Error ? error.message : String(error);
}
