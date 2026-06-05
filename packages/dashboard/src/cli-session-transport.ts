/**
 * cli-session-transport — shared transport primitives for CLI agent sessions
 * (CLI Agent Executor, U10).
 *
 * Holds the pieces the REST router (cli-sessions.ts) and the WS attach handler
 * (server.ts wiring) both depend on:
 * - the narrow manager/store/hub interfaces the transport needs (so tests can
 *   supply a fake CliSessionManager without a real PTY),
 * - the short-lived, single-use, session-scoped ATTACH TICKET store,
 * - input-source ATTRIBUTION bookkeeping (ticket id → session input log),
 * - the generic-tier CONFIRM-ADVANCE flag/event seam,
 * - the ORIGIN allowlist check for the WS upgrade.
 *
 * Attach auth (KTD): the long-lived daemon token alone never authorizes PTY
 * WRITE access. A surface must first call the authenticated attach-ticket route
 * (daemon-token gated), then present the single-use ticket on the WS upgrade —
 * which ALSO re-checks the daemon token and an Origin allowlist. Keystroke
 * injection into a privileged agent PTY warrants the stronger posture.
 */

import { randomBytes } from "node:crypto";
import type { CliSession, CliSessionStore } from "@fusion/core";
import {
  stripAnsiControl,
  type CliSessionAttachment,
  type CliStateChange,
} from "@fusion/engine";
import { emitCliSessionStateSseEvent } from "./sse.js";

// ── Narrow interfaces the transport needs ────────────────────────────────────

/**
 * The subset of the engine `CliSessionManager` the transport touches. The real
 * manager satisfies this; WS tests supply a fake (no PTY) implementing exactly
 * these members.
 */
export interface CliSessionManagerLike {
  /** Whether a session id is currently live (attachable). */
  isLive(sessionId: string): boolean;
  /** Attach a client: scrollback + live stream + write/resize/detach. */
  attach(sessionId: string): CliSessionAttachment;
  /** Inject a composed/engine prompt (neutralized) onto the shared FIFO. */
  inject(sessionId: string, text: string): Promise<void>;
  /** High-watermark backpressure: pause the PTY. */
  requestPause(sessionId: string): void;
  /** Low-watermark backpressure release: resume the PTY. */
  requestResume(sessionId: string): void;
}

/** Dependencies the transport binds to (engine-owned, supplied at setup). */
export interface CliSessionTransportDeps {
  manager: CliSessionManagerLike;
  store: Pick<CliSessionStore, "getSession" | "listSessions">;
}

// ── Attach tickets ───────────────────────────────────────────────────────────

/** Default attach-ticket TTL (ms). Short-lived: enough to open a WS, no more. */
export const DEFAULT_ATTACH_TICKET_TTL_MS = 60_000;

interface AttachTicketEntry {
  ticket: string;
  sessionId: string;
  projectId: string;
  /** Whether write (input/inject over WS) is permitted (read-only sessions: false). */
  readOnly: boolean;
  expiresAt: number;
  consumed: boolean;
}

/**
 * In-memory, single-use, session-scoped attach-ticket store. A ticket is minted
 * by the authenticated REST route, then consumed exactly once on the WS upgrade.
 * Expired/consumed tickets never validate, and a ticket for session A can never
 * attach session B (the session id is bound into the ticket).
 */
export class AttachTicketStore {
  private readonly tickets = new Map<string, AttachTicketEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts?: { ttlMs?: number; now?: () => number }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_ATTACH_TICKET_TTL_MS;
    this.now = opts?.now ?? (() => Date.now());
  }

  /** Mint a ticket for a session. Returns the opaque ticket + its expiry. */
  mint(input: {
    sessionId: string;
    projectId: string;
    readOnly: boolean;
  }): { ticket: string; expiresAt: number } {
    const ticket = randomBytes(24).toString("hex");
    const expiresAt = this.now() + this.ttlMs;
    this.tickets.set(ticket, {
      ticket,
      sessionId: input.sessionId,
      projectId: input.projectId,
      readOnly: input.readOnly,
      expiresAt,
      consumed: false,
    });
    return { ticket, expiresAt };
  }

  /**
   * Consume a ticket for a specific session (single-use). Returns the entry on
   * success, or null when: unknown, already consumed, expired, or bound to a
   * DIFFERENT session than `sessionId`.
   */
  consume(ticket: string | null | undefined, sessionId: string): AttachTicketEntry | null {
    if (!ticket) return null;
    const entry = this.tickets.get(ticket);
    if (!entry) return null;
    if (entry.consumed) return null;
    if (this.now() > entry.expiresAt) {
      this.tickets.delete(ticket);
      return null;
    }
    if (entry.sessionId !== sessionId) return null;
    entry.consumed = true;
    // Keep briefly for attribution, but it can never be reused.
    return entry;
  }

  /** Sweep expired tickets (best-effort housekeeping). */
  sweepExpired(): void {
    const now = this.now();
    for (const [ticket, entry] of this.tickets) {
      if (now > entry.expiresAt) this.tickets.delete(ticket);
    }
  }
}

// ── Input-source attribution ─────────────────────────────────────────────────

export interface CliInputAttributionEntry {
  /** The ticket id the input arrived under (the accountability floor in v1). */
  ticketId: string;
  /** "ws" for WS input frames, "inject" for the REST inject route. */
  source: "ws" | "inject";
  /** Byte length of the input (not the content — content is not retained). */
  byteLength: number;
  at: string;
}

/**
 * In-memory per-session input-attribution log. v1 has no per-user arbitration,
 * so logging which ticket each input frame arrived under is the accountability
 * floor for post-incident attribution.
 */
export class CliInputAttributionLog {
  private readonly bySession = new Map<string, CliInputAttributionEntry[]>();
  private readonly cap: number;

  constructor(opts?: { capPerSession?: number }) {
    this.cap = opts?.capPerSession ?? 1000;
  }

  record(sessionId: string, entry: CliInputAttributionEntry): void {
    let list = this.bySession.get(sessionId);
    if (!list) {
      list = [];
      this.bySession.set(sessionId, list);
    }
    list.push(entry);
    if (list.length > this.cap) list.splice(0, list.length - this.cap);
  }

  list(sessionId: string): CliInputAttributionEntry[] {
    return [...(this.bySession.get(sessionId) ?? [])];
  }
}

// ── Confirm-advance (generic-tier R20 affordance) ────────────────────────────

export type CliConfirmAdvanceListener = (info: {
  sessionId: string;
  projectId: string;
  decision: "advance" | "not-yet";
}) => void;

/**
 * The generic-tier "this session looks idle — advance to review?" affordance.
 * The engine pipeline layer acts on the event later; for now the transport
 * persists the latest decision per session and emits to subscribers (the engine
 * seam wires a listener in a later unit).
 */
export class CliConfirmAdvanceRegistry {
  private readonly latest = new Map<string, "advance" | "not-yet">();
  private readonly listeners = new Set<CliConfirmAdvanceListener>();

  on(listener: CliConfirmAdvanceListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  record(sessionId: string, projectId: string, decision: "advance" | "not-yet"): void {
    this.latest.set(sessionId, decision);
    for (const listener of this.listeners) {
      listener({ sessionId, projectId, decision });
    }
  }

  getLatest(sessionId: string): "advance" | "not-yet" | undefined {
    return this.latest.get(sessionId);
  }
}

// ── Read-only enforcement ────────────────────────────────────────────────────

/**
 * Whether a session is read-only (one-shot validator/planning, U9). Server-side
 * enforcement (not just client) — input/inject is rejected for these.
 *
 * U9's one-shot sessions are not yet wired, so the current signal is the
 * autonomy posture `readOnly` flag (forward-compatible) plus validator/planning
 * purposes which are inherently read-only.
 */
export function isReadOnlySession(session: CliSession): boolean {
  if (session.autonomyPosture && session.autonomyPosture.readOnly === true) return true;
  return session.purpose === "validator" || session.purpose === "planning";
}

// ── Origin allowlist ─────────────────────────────────────────────────────────

/**
 * Origin allowlist check for the WS upgrade. Rejects a foreign or absent Origin
 * (a privileged keystroke channel must not be CSRF-attachable from another
 * page). Allowed:
 * - no Origin header AND not a browser context (native clients: TUI, our own WS
 *   client set no Origin) — these are allowed because they aren't subject to the
 *   browser same-origin model and authenticate via the daemon token + ticket.
 *   We detect "browser context" by the presence of `Sec-Fetch-Site` / a
 *   `User-Agent` claiming a browser; absent those, an absent Origin is a native
 *   client.
 * - an Origin whose host matches the request Host (same-host), or
 * - an Origin in the configured extras allowlist.
 *
 * Per the plan, a FOREIGN or ABSENT Origin from a browser is rejected.
 */
export interface OriginCheckInput {
  origin: string | undefined;
  host: string | undefined;
  /** Sec-Fetch-Site header (present on browser-issued requests). */
  secFetchSite?: string | undefined;
  /** Extra allowed origins (exact, scheme+host[:port]) from config. */
  extraAllowedOrigins?: string[];
}

// ── SSE state bridge ─────────────────────────────────────────────────────────

/** Default cap (chars) on the SSE last-output preview. */
export const DEFAULT_OUTPUT_PREVIEW_CHARS = 200;

/**
 * Bound + sanitize a last-output preview for the SSE `cli:session:state` event:
 * ANSI/control-stripped, redacted, and capped (~200 chars). The text is already
 * expected to be recent output (e.g. the scrollback tail); we strip first, then
 * the engine's redaction is applied by the supplier — but we strip here defensively.
 */
export function buildOutputPreview(
  raw: string | undefined,
  maxChars = DEFAULT_OUTPUT_PREVIEW_CHARS,
): string | undefined {
  if (!raw) return undefined;
  const stripped = stripAnsiControl(raw).replace(/\s+/g, " ").trim();
  if (stripped.length === 0) return undefined;
  return stripped.length > maxChars ? stripped.slice(-maxChars) : stripped;
}

/**
 * Subscribe to an engine state machine's throttled `onStateChange` and forward
 * each transition onto the SSE bus as a `cli:session:state` event. The engine
 * applies the ~500ms throttle (via `stateChangeThrottleMs`); this bridge only
 * shapes the payload (owning entity + bounded redacted preview) and routes it
 * project-scoped.
 *
 * Returns an unsubscribe handle.
 */
export function bridgeCliStateToSse(
  machine: { onStateChange(listener: (change: CliStateChange) => void): () => void },
  deps: {
    store: Pick<CliSessionStore, "getSession">;
    /** Recent (raw) output supplier for the bounded preview (e.g. scrollback tail). */
    getRecentOutput?: (sessionId: string) => string | undefined;
  },
): () => void {
  return machine.onStateChange((change) => {
    const session = deps.store.getSession(change.sessionId);
    const preview = buildOutputPreview(deps.getRecentOutput?.(change.sessionId));
    emitCliSessionStateSseEvent(
      {
        sessionId: change.sessionId,
        taskId: session?.taskId ?? null,
        chatSessionId: session?.chatSessionId ?? null,
        state: change.state,
        terminationReason: change.terminationReason,
        lastOutputPreview: preview,
        at: change.at,
      },
      session?.projectId,
    );
  });
}

export function isOriginAllowed(input: OriginCheckInput): boolean {
  const { origin, host, secFetchSite, extraAllowedOrigins } = input;

  // No Origin header.
  if (!origin) {
    // A browser ALWAYS sends Origin on a cross-site WS and sets Sec-Fetch-Site;
    // an absent Origin together with a browser signal is suspicious → reject.
    if (secFetchSite && secFetchSite !== "none" && secFetchSite !== "same-origin") {
      return false;
    }
    // Native client (TUI / our WS client) — allowed (token + ticket gated).
    return true;
  }

  // Parse the Origin.
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false; // malformed Origin → reject
  }

  // Same-host: the Origin's host:port matches the request Host header.
  if (host && originUrl.host === host) {
    return true;
  }

  // Extras allowlist (exact scheme+host[:port]).
  if (extraAllowedOrigins && extraAllowedOrigins.length > 0) {
    const normalized = `${originUrl.protocol}//${originUrl.host}`;
    if (extraAllowedOrigins.some((o) => o === normalized || o === origin)) {
      return true;
    }
  }

  return false;
}
